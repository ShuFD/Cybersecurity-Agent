import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { throwIfAborted } from "../../subagent.ts";
import type { TrustedPlanningVerification } from "../contracts.ts";
import { evidenceBoardView } from "../evidence-cards.ts";
import type { PlanningCapacityControl, PlanningExecutorPool } from "../execution-pool.ts";
import { createPlanRunObserver } from "../observer-model.ts";
import { OpportunityReview } from "../opportunity-review.ts";
import type { PiPlanningAdapterOptions } from "../pi-adapters.ts";
import { generatePlanningProposal } from "../proposal-model.ts";
import type { PlanRunObserver } from "../run-observer.ts";
import { PlanningSourceBindings } from "../source-bindings.ts";
import { CairnHostEvidence } from "./host-evidence.ts";
import { ReasonWorker } from "./reason-worker.ts";
import { GraphReasoner } from "./reasoner.ts";
import { prepareManagedProposal, preserveManagedWork, recoverManagedProposal } from "./recovery-proposal.ts";
import { SchedulerCoordinator } from "./scheduler-coordinator.ts";
import { SchedulerWorker } from "./scheduler-worker.ts";
import { GraphService } from "./service.ts";
import { CairnSolverAdapter } from "./solver.ts";
import { GraphStore } from "./store.ts";
import {
	buildCairnSubmissionBoard,
	cairnProposalSchema,
	normalizeCairnSubmission,
	validateCairnSubmission,
} from "./submission-contract.ts";
import type { ChallengeGraphSnapshot, ReasonModel } from "./types.ts";

export interface CairnEngineOptions extends PiPlanningAdapterOptions {
	requireTrustedCompletion?: boolean;
	capacityControl: PlanningCapacityControl;
	executorPool?: PlanningExecutorPool;
	reasonModel?: ReasonModel;
	onRunStarted?: (runId: string) => Promise<void>;
}
export interface CairnEngineResult {
	engine: "cairn";
	runId: string;
	status: "completed" | "exhausted" | "idle";
	graph: ChallengeGraphSnapshot;
	trustedVerification?: TrustedPlanningVerification;
	lastReasonFailure?: { error: string; modelCalls: number };
}
export function cairnRunDirectory(stateDir: string, runId: string): string {
	if (!/^planning_cairn_[a-f0-9]{32}$/.test(runId)) throw new Error("Invalid Cairn run identity");
	return join(stateDir, "planning", "cairn", runId);
}
export class CairnPlanningEngine {
	private readonly options: CairnEngineOptions;
	constructor(options: CairnEngineOptions) {
		this.options = options;
	}
	async execute(input: { outerTaskId: string; goal: string; signal?: AbortSignal }): Promise<CairnEngineResult> {
		throwIfAborted(input.signal);
		// Separate from progressive IDs, and from prior prompts with the same goal.
		const runId =
			"planning_cairn_" +
			createHash("sha256")
				.update(JSON.stringify([input.outerTaskId, input.goal, randomUUID()]))
				.digest("hex")
				.slice(0, 32);
		const directory = cairnRunDirectory(this.options.config.stateDir, runId);
		mkdirSync(directory, { recursive: true });
		const store = new GraphStore(join(directory, "graph.sqlite"));
		let evidence: CairnHostEvidence | undefined;
		let solvers: CairnSolverAdapter | undefined;
		let reasonWorker: ReasonWorker | undefined;
		let schedulerWorker: SchedulerWorker | undefined;
		const control = new AbortController();
		const signal = input.signal ? AbortSignal.any([input.signal, control.signal]) : control.signal;
		let failure: unknown;
		let reasonCalls = 0;
		let lastReasonFailure: CairnEngineResult["lastReasonFailure"];
		let reasonActive = false;
		let unschedulableIntentIds: string[] = [];
		let lastReap = 0;
		let status: CairnEngineResult["status"] = "idle";
		let stopScheduling = false;
		let runObserver: PlanRunObserver | undefined;
		let lastSchedule = "";
		const opportunityReview = new OpportunityReview();
		const managed = this.options.requireTrustedCompletion === true;
		const maximumSteps = managed ? Number.MAX_SAFE_INTEGER : this.options.config.planning.maxSteps;
		const maximumTasks = managed ? Number.MAX_SAFE_INTEGER : this.options.config.planning.maxTasks;
		try {
			await this.options.onRunStarted?.(runId);
			store.initialize();
			evidence = new CairnHostEvidence(join(directory, "host.sqlite"));
			const host = evidence;
			const sourceBindings = new PlanningSourceBindings(this.options.config.stateDir, runId, (id) => {
				const record = host.read(runId, id);
				if (!record) throw new Error("Evidence does not belong to this run");
				return {
					runId,
					evidenceId: id,
					value: { result: JSON.parse(record.content) as unknown, input: record.toolInput },
					sourceHash: createHash("sha256")
						.update(JSON.stringify([record.content, record.toolInput]))
						.digest("hex"),
					outcome: record.isError ? "tool_error" : "observation",
				};
			});
			const service = new GraphService(store, {
				artifactRoot: join(directory, "artifacts"),
				reasonerEnabled: true,
				maxReasonAttempts: Number.MAX_SAFE_INTEGER,
			});
			const actor = { id: "secheur-host", role: "host" as const, challengeId: runId };
			const createdAt = new Date().toISOString();
			const candidate = service.proposeFact({
				actor,
				idempotencyKey: "goal",
				createdAt,
				kind: "goal",
				statement: input.goal,
				confidence: 1,
			});
			service.confirmFact({ actor, idempotencyKey: "confirm-goal", createdAt, candidateId: candidate.id });
			service.expireLeases(runId);
			service.expireReasonLeases();
			service.ensureReasonTriggerForChallenge(runId);
			const fatal = (error: unknown): void => {
				if (host.proof(runId)) return;
				failure ??= error;
				stopScheduling = true;
				control.abort(error);
			};
			if (this.options.config.planning.observerMode !== "off")
				runObserver = createPlanRunObserver(this.options, {
					runId,
					mode: this.options.config.planning.observerMode,
					signal,
					beforeDispatch: this.options.beforeDispatch,
					readEvidence: (id, offset, limit) => {
						const record = host.read(runId, id);
						if (!record) throw new Error("Evidence does not belong to this run");
						const original = JSON.stringify(record);
						return {
							evidenceId: record.evidenceId,
							intentId: record.intentId,
							toolName: record.toolName,
							isError: record.isError,
							content: original.slice(offset, offset + limit),
							offset,
							nextOffset: Math.min(original.length, offset + limit),
							totalChars: original.length,
							hasMore: offset + limit < original.length,
						};
					},
					onEvent: (type, payload) => host.event(runId, type, payload),
					snapshot: () => {
						const records = host.listAll(runId);
						return {
							runId,
							version: store.getLatestEventSequence(runId),
							evidenceIds: records.map((record) => record.evidenceId),
							context: {
								recentEvidence: records.slice(-6).map((pointer) => ({
									...pointer,
									resultPreview: host.read(runId, pointer.evidenceId)?.content.slice(0, 240),
								})),
								graph: store.readServiceGraph(runId),
								evidence: records,
								sourceBindings: sourceBindings.list(),
							},
						};
					},
					validateCorrection: (correction) => {
						const graph = store.readServiceGraph(runId);
						const old = graph.facts.find((fact) => fact.id === correction.factId && fact.status === "active");
						const replacement = graph.facts.find(
							(fact) => fact.id === correction.replacementFactId && fact.status === "active",
						);
						return Boolean(
							old &&
								replacement &&
								old.kind !== "goal" &&
								sourceBindings.provesCorrection(old.statement, replacement.statement, correction.evidenceIds),
						);
					},
					applyCorrection: (correction) =>
						service.invalidateFact({
							actor,
							createdAt: new Date().toISOString(),
							idempotencyKey: `observer-correction:${correction.factId}:${correction.replacementFactId}`,
							factId: correction.factId,
							replacementFactId: correction.replacementFactId,
						}),
				});
			solvers = new CairnSolverAdapter({
				...this.options,
				overallGoal: input.goal,
				sourceBindings,
				runObserver,
				taskTimeoutMs: managed ? undefined : this.options.config.planning.taskTimeoutMs,
				runId,
				service,
				evidence: host,
				signal,
				leaseDurationMs: Math.min(300_000, Math.max(5_000, this.options.config.planning.leaseTtlMs)),
				onSettled: () => {},
				onFailure: fatal,
				onVerified: () => {
					store.markChallengeCompleted(runId, new Date().toISOString());
					stopScheduling = true;
				},
			});
			const adapter = solvers;
			const model: ReasonModel = {
				generate: async (request, reasonSignal) => {
					if (reasonCalls >= maximumSteps) throw new Error("Maximum planning model-call budget reached");
					reasonCalls++;
					host.event(runId, "cairn_reason_start", { attempt: reasonCalls });
					try {
						if (this.options.reasonModel) return await this.options.reasonModel.generate(request, reasonSignal);
						const output = await generatePlanningProposal({
							nativeSession: {
								queryPolicy: "board_only",
								compactBoardContext: {
									...buildCairnSubmissionBoard(
										store.readServiceGraph(runId),
										host.listAll(runId),
										runObserver?.overview() ?? [],
										sourceBindings.list(),
									),
									evidenceBoard: evidenceBoardView(host.cards(runId)),
								},
								readonlyContext: (() => {
									const graph = store.readServiceGraph(runId);
									return {
										run: { runId },
										changes: {
											triggers: store.readReasonTriggers(runId, 16),
											currentOwners: graph.intents.filter((i) => ["claimed", "running"].includes(i.status)),
											recentDeliveries: graph.intents.filter((i) => i.status === "concluded").slice(-4),
										},
										graph,
										facts: graph.facts,
										evidenceBoard: evidenceBoardView(host.cards(runId)),
										tasks: graph.intents,
										hints: graph.hints,
										evidence: host.listAll(runId).map((item) => ({
											evidenceId: item.evidenceId,
											intentId: item.intentId,
											toolName: item.toolName,
											isError: item.isError,
											summary: Array.from(
												graph.facts.find((fact) => fact.evidenceRefs.includes(item.evidenceId))
													?.statement ??
													"No executor summary yet; request a specific summary from the owner if necessary.",
											)
												.slice(0, 50)
												.join(""),
											summaryOrigin: "executor_claim_or_missing",
										})),
										sourceBindings: sourceBindings.list(),
										observerNotes: runObserver?.overview() ?? [],
									};
								})(),
								readEvidence: (id, offset, limit) => {
									const record = host.read(runId, id);
									if (!record) throw new Error("Evidence does not belong to this run");
									const original = JSON.stringify(record);
									return {
										evidenceId: record.evidenceId,
										intentId: record.intentId,
										toolName: record.toolName,
										isError: record.isError,
										content: original.slice(offset, offset + limit),
										offset,
										nextOffset: Math.min(original.length, offset + limit),
										totalChars: original.length,
										hasMore: offset + limit < original.length,
									};
								},
								normalizeSubmission: (value) =>
									normalizeCairnSubmission(
										value,
										store.readServiceGraph(runId),
										host.listAll(runId).map((item) => item.evidenceId),
									),
								validateSubmission: (value) =>
									validateCairnSubmission(
										value,
										store.readServiceGraph(runId),
										host.listAll(runId).map((item) => item.evidenceId),
									),
							},
							beforeDispatch: this.options.beforeDispatch,
							outputSchema: cairnProposalSchema,
							onLifecycleEvent: (type, payload) => host.event(runId, type, payload ?? {}),
							config: this.options.config,
							cwd: this.options.cwd,
							model: this.options.model,
							maxOutputTokens: request.maxOutputTokens,
							modelRuntime: this.options.modelRuntime,
							onModelTurn: this.options.onModelTurn,
							thinkingLevel: this.options.thinkingLevel,
							task:
								request.prompt +
								`\nPer-goal executor capacity: ${this.options.capacityControl.getCapacity()}. Simple short work may use one owner. For complex work identify independent bounded questions and use both slots when this reduces the critical path. Keep dependent steps with their owner. Do not manufacture a review or duplicate the whole task. On later plans reuse saved evidence and active executors; no new task is necessary when existing owners cover the useful work.` +
								"\nAvailable Solver profile: current. It uses the current model/tools. " +
								"No capability tags are declared; use capabilityTags: [] for this profile.",
							signal: reasonSignal,
						});
						return {
							text: output.finalText,
							model: output.messages[0].model,
							provider: output.messages[0].provider,
						};
					} finally {
						host.event(runId, "cairn_reason_end", { attempt: reasonCalls });
					}
				},
			};
			const reasoner = new GraphReasoner({
				service,
				model,
				reasonApplyEnabled: true,
				correctionAttempts: 2,
				prepareDraft: managed
					? (draft, context) => prepareManagedProposal(draft, context, this.options.capacityControl.getCapacity())
					: undefined,
				recoverDraft: managed
					? (context) => recoverManagedProposal(context, this.options.capacityControl.getCapacity())
					: undefined,
				onCorrection: (event) => host.event(runId, "cairn_proposal_correction", event),
				preserveDraft: managed
					? (context) => preserveManagedWork(context, this.options.capacityControl.getCapacity())
					: undefined,
				onPreservedWork: () =>
					host.event(runId, "cairn_reason_preserved_work", { modelCalled: false, origin: "host_preserve" }),
				timeoutMs: managed ? 0 : undefined,
				allowNoopProposal: () => adapter.snapshots().some((s) => s.activeIntentId !== undefined),
				validateDraft: managed
					? (draft) =>
							draft.proposedIntents.some((intent) => intent.capabilityTags.length > 0)
								? [
										"no_compatible_profile: current Solver declares no capability tags. Use capabilityTags: [] and a complete executable objective; do not invent profiles.",
									]
								: []
					: undefined,
			});
			reasonWorker = new ReasonWorker({
				intervalMs: 500,
				service: {
					listReasonWorkChallenges: () =>
						stopScheduling ||
						reasonCalls >= maximumSteps ||
						store.readServiceGraph(runId).intents.length >= maximumTasks
							? []
							: service.listReasonWorkChallenges(),
				},
				reasoner: {
					runOnce: async (challengeId, workerSignal) => {
						const combined = workerSignal ? AbortSignal.any([signal, workerSignal]) : signal;
						throwIfAborted(combined);
						reasonActive = true;
						try {
							const result = await reasoner.runOnce(challengeId, combined);
							if (result.status === "failed")
								lastReasonFailure = { error: result.error, modelCalls: reasonCalls };
							else if (result.status === "proposed") lastReasonFailure = undefined;
							host.event(runId, "cairn_reason_result", {
								status: result.status,
								...(result.status === "failed" ? { error: result.error } : {}),
							});
							return result;
						} finally {
							reasonActive = false;
						}
					},
					abortAll: () => reasoner.abortAll(),
				},
				onError: fatal,
			});
			const coordinator = new SchedulerCoordinator({
				hostId: actor.id,
				leaseDurationMs: Math.min(300_000, Math.max(5_000, this.options.config.planning.leaseTtlMs)),
				service,
				listSolvers: () => adapter.snapshots(),
				listProfiles: async () => [{ id: "current", capabilityTags: [], tools: [], skills: [], mcps: [] }],
				readCapacity: async () => {
					const pool = adapter.getExecutorPoolStatus(this.options.capacityControl.getCapacity());
					return {
						perChallengeSolverCap: this.options.capacityControl.getCapacity(),
						globalRemainingSolverSlots: Math.max(0, pool.capacity - pool.active),
					};
				},
				launchSolver: async (request) => {
					if (stopScheduling || signal.aborted) throw new Error("Cairn scheduling stopped");
					await adapter.launch(request);
				},
				bindSolverLease: (id, lease) => adapter.bindExisting(id, lease),
				reuseSolver: async (request) => {
					if (stopScheduling || signal.aborted) throw new Error("Cairn scheduling stopped");
					await adapter.reuse(request);
				},
				stopSolver: (id) => adapter.stop(id),
			});
			schedulerWorker = new SchedulerWorker({
				intervalMs: 500,
				service: {
					listSchedulerWorkChallenges: () => (stopScheduling ? [] : service.listSchedulerWorkChallenges()),
				},
				coordinator: {
					runChallengeOnce: async (challengeId) => {
						await adapter.trimIdle(this.options.capacityControl.getCapacity());
						const result = await coordinator.runChallengeOnce(challengeId);
						unschedulableIntentIds = result.plan.skipped
							.filter(
								(item) => item.reason === "no_compatible_profile" || item.reason === "inactive_or_missing_fact",
							)
							.map((item) => item.intentId);
						const schedule = {
							assignmentCount: result.assignments.length,
							activeCount: result.plan.activeChallengeSolverCount,
							capacity: this.options.capacityControl.getCapacity(),
							skipped: result.plan.skipped.map(({ intentId, reason }) => ({ intentId, reason })),
						};
						const signature = JSON.stringify(schedule);
						if (signature !== lastSchedule) {
							host.event(runId, "cairn_schedule", schedule);
							lastSchedule = signature;
						}
						return result;
					},
				},
				onError: fatal,
			});
			host.event(runId, "cairn_run_start", { capacity: this.options.capacityControl.getCapacity() });
			reasonWorker.start();
			schedulerWorker.start();
			while (true) {
				throwIfAborted(input.signal);
				if (failure) throw failure;
				// Reuse the Graph service's lease recovery; never leave an abandoned claim
				// permanently occupying a slot. These synchronous operations need no timer worker.
				if (Date.now() - lastReap >= 1_000) {
					service.expireLeases(runId);
					service.expireReasonLeases();
					lastReap = Date.now();
				}
				const proof = host.proof(runId);
				if (proof) {
					status = "completed";
					break;
				}
				const graph = store.readServiceGraph(runId);
				const occupied = adapter.snapshots().filter((s) => s.activeIntentId !== undefined).length;
				opportunityReview.update(
					JSON.stringify([graph.intents.map((i) => [i.id, i.status]), graph.facts.map((f) => [f.id, f.status])]),
					occupied,
					this.options.capacityControl.getCapacity(),
				);
				if (managed && occupied === 1 && !reasonActive && opportunityReview.due()) {
					service.ensureReasonTriggerForChallenge(runId, true);
					host.event(runId, "planning_opportunity_review", {
						origin: "host_timer",
						activeCount: occupied,
						capacity: this.options.capacityControl.getCapacity(),
					});
					opportunityReview.reviewed();
				}
				const pending = store.readActionableReasonTrigger(runId) !== undefined;
				const active = adapter.snapshots().some((s) => s.activeIntentId !== undefined);
				const open = graph.intents.some((t) => ["open", "claimed", "running"].includes(t.status));
				const stalled = graph.intents
					.filter((t) => ["open", "claimed", "running"].includes(t.status))
					.every((t) => t.status === "open" && unschedulableIntentIds.includes(t.id));
				if (
					!active &&
					!reasonActive &&
					(!open || stalled) &&
					(!pending || reasonCalls >= maximumSteps || graph.intents.length >= maximumTasks)
				) {
					if (reasonCalls >= maximumSteps || graph.intents.length >= maximumTasks) {
						status = "exhausted";
						break;
					}
					service.ensureReasonTriggerForChallenge(runId, true);
					host.event(runId, "cairn_recovery_pending", { reason: "no_runnable_intent", modelCalls: reasonCalls });
				}
				await wait(100, undefined, { signal });
			}
			stopScheduling = true;
			reasonWorker.stop();
			schedulerWorker.stop();
			await Promise.all([reasonWorker.waitForIdle(), schedulerWorker.waitForIdle()]);
			await adapter.close();
			if (failure) throw failure;
			const result: CairnEngineResult = {
				engine: "cairn",
				runId,
				status,
				graph: store.readServiceGraph(runId),
				...(lastReasonFailure ? { lastReasonFailure } : {}),
				...(host.proof(runId) ? { trustedVerification: host.proof(runId) } : {}),
			};
			host.event(runId, "cairn_run_end", { status });
			writeFileSync(join(directory, "result.json"), JSON.stringify(result, null, 2));
			return result;
		} catch (error) {
			evidence?.event(runId, "cairn_run_end", { status: input.signal?.aborted ? "cancelled" : "failed" });
			if (input.signal?.aborted) throw input.signal.reason ?? error;
			throw failure ?? error;
		} finally {
			runObserver?.close();
			stopScheduling = true;
			control.abort(new Error("Cairn run ended"));
			reasonWorker?.stop();
			schedulerWorker?.stop();
			await Promise.all([reasonWorker?.waitForIdle(), schedulerWorker?.waitForIdle()]);
			await solvers?.close();
			evidence?.close();
			store.close();
		}
	}
}
