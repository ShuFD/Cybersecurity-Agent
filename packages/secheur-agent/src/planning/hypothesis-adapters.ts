import type { AgentToolResult, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { compilePlanningProposal } from "./compiler.ts";
import {
	type PlanningPlanProposal,
	type PlanningSnapshot,
	parsePlanningPlanProposal,
	stablePlanningTaskId,
	validatePlanningDependencies,
} from "./contracts.ts";
import { TASK_DELIVERY_PREVIEW_CHARS, evidenceCardId } from "./evidence-cards.ts";
import { evidenceCardSchema } from "./evidence-tools.ts";
import { isPlanningFailureError, planningFailure } from "./failures.ts";
import type { PlanningSupervisor } from "./harness.ts";
import {
	applyHypothesisUpdate,
	emptyHypothesisGraph,
	HYPOTHESIS_INPUT_CODES,
	HypothesisInputError,
	hypothesisId,
	resolveHypothesisArtifactInput,
} from "./hypothesis-graph.ts";
import type { HypothesisGraphUpdate, HypothesisObservation } from "./hypothesis-types.ts";
import type { PiPlanningAdapterOptions, PlanningChildScope } from "./pi-adapters.ts";
import { generatePlanningProposal } from "./proposal-model.ts";
import { fillHostPlanningFields } from "./proposal-session.ts";
import { planningChangesOverview } from "./review-changes.ts";
import type { PlanningStore } from "./store.ts";

const refs = Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 32 });
const hypothesis = Type.Object(
	{
		key: Type.String({ minLength: 1, maxLength: 120 }),
		statement: Type.String({ minLength: 1, maxLength: 1000 }),
		basisRefs: refs,
		parentHypothesisIds: refs,
		verificationCriteria: Type.String({ minLength: 1, maxLength: 1000 }),
		refutationCriteria: Type.String({ minLength: 1, maxLength: 1000 }),
	},
	{ additionalProperties: false },
);
const requiredInput = Type.Object(
	{
		sourceTaskId: Type.Optional(Type.String()),
		artifactPath: Type.Optional(Type.String()),
		evidenceId: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
const taskSchema = Type.Object(
	{
		key: Type.Optional(Type.String()),
		objective: Type.String({ minLength: 1, maxLength: 2000 }),
		doneWhen: Type.String({ minLength: 1, maxLength: 1000 }),
		dependsOn: Type.Optional(refs),
		inputEvidenceRefs: Type.Optional(refs),
		hypothesisIds: refs,
		purpose: Type.Union([
			Type.Literal("test_hypothesis"),
			Type.Literal("gather_evidence"),
			Type.Literal("verify_goal"),
			Type.Literal("review_basis"),
		]),
		requiredInputs: Type.Optional(Type.Array(requiredInput, { maxItems: 16 })),
	},
	{ additionalProperties: false },
);
export const hypothesisProposalSchema = Type.Object(
	{
		decision: Type.Union([Type.Literal("create_tasks"), Type.Literal("blocked"), Type.Literal("finish_run")]),
		rationale: Type.String({ maxLength: 2000 }),
		newHypotheses: Type.Array(hypothesis, { maxItems: 4 }),
		tasks: Type.Array(taskSchema, { maxItems: 4 }),
		answerEvidenceRefs: Type.Optional(refs),
		waitForTaskIds: Type.Optional(refs),
	},
	{ additionalProperties: false },
);

export const hypothesisObservationSchema = Type.Object(
	{
		expectedVersion: Type.Optional(Type.Integer({ minimum: 0 })),
		card: evidenceCardSchema,
		resolutions: Type.Optional(
			Type.Array(
				Type.Object(
					{
						hypothesisId: Type.String(),
						verdict: Type.Union([
							Type.Literal("verified"),
							Type.Literal("refuted"),
							Type.Literal("undetermined"),
						]),
						explanation: Type.String({ minLength: 1, maxLength: 2000 }),
						evidenceRefs: refs,
						reviewOfEvidenceRefs: Type.Optional(refs),
					},
					{ additionalProperties: false },
				),
				{ maxItems: 4 },
			),
		),
	},
	{ additionalProperties: false },
);

export function hypothesisPlannerView(snapshot: PlanningSnapshot) {
	const graph = {
		...(snapshot.hypothesisGraph ?? emptyHypothesisGraph()),
		cards: snapshot.evidenceCards ?? snapshot.hypothesisGraph?.cards ?? [],
	};
	const latestCardSummaries = new Map(
		graph.cards.flatMap((card) => card.evidenceRefs.map((id) => [id, card.summary] as const)),
	);
	const activeTasks = new Set(
		snapshot.tasks
			.filter((task) => ["proposed", "ready", "leased", "running"].includes(task.status))
			.map((task) => task.taskId),
	);
	const nodeIds = new Set(
		graph.nodes
			.filter((node) => !["verified", "refuted"].includes(node.status) || node.needsReview)
			.map((node) => node.id),
	);
	for (const binding of graph.taskBindings)
		if (activeTasks.has(binding.taskId)) for (const id of binding.hypothesisIds) nodeIds.add(id);
	for (;;) {
		const previousSize = nodeIds.size;
		for (const node of graph.nodes)
			if (nodeIds.has(node.id)) for (const id of node.parentHypothesisIds) nodeIds.add(id);
		if (nodeIds.size === previousSize) break;
	}
	const taskIds = new Set([...activeTasks, ...snapshot.tasks.slice(-12).map((task) => task.taskId)]);
	for (const binding of graph.taskBindings)
		if (activeTasks.has(binding.taskId)) for (const input of binding.requiredInputs) taskIds.add(input.sourceTaskId);
	const evidenceIds = new Set(
		graph.nodes
			.filter((node) => nodeIds.has(node.id))
			.flatMap((node) => [...node.basisRefs, ...node.verificationEvidenceRefs]),
	);
	for (const task of snapshot.tasks)
		if (taskIds.has(task.taskId)) for (const id of task.inputEvidenceRefs ?? []) evidenceIds.add(id);
	const cards = graph.cards.filter(
		(card, index) =>
			index >= graph.cards.length - 12 ||
			activeTasks.has(card.sourceTaskId) ||
			card.evidenceRefs.some((id) => evidenceIds.has(id)),
	);
	for (const card of cards) for (const id of card.evidenceRefs) evidenceIds.add(id);
	const viewGraph = {
		...graph,
		nodes: graph.nodes.filter((node, index) => nodeIds.has(node.id) || index >= graph.nodes.length - 8),
		cards: cards.map((card) => ({
			...card,
			keyValues: Object.fromEntries(
				Object.entries(card.keyValues).map(([key, value]) => [
					key,
					JSON.stringify(value).length <= 512
						? value
						: { detailOmitted: true, sourceEvidenceRefs: card.evidenceRefs },
				]),
			),
		})),
		taskBindings: graph.taskBindings.filter((binding) => taskIds.has(binding.taskId)),
		checkpointArtifacts: graph.checkpointArtifacts?.filter((item) => taskIds.has(item.sourceTaskId)),
	};
	return {
		run: { ...snapshot.run, humanPromptRef: "human:goal" },
		hypothesisGraph: viewGraph,
		tasks: snapshot.tasks
			.filter((task) => taskIds.has(task.taskId))
			.map((task) => ({ ...task, inputEvidenceRefs: task.inputEvidenceRefs ?? [] })),
		blackboard: {
			taskDeliveries: snapshot.executionFrame.frame.taskSummaries
				.filter((item) => taskIds.has(item.taskId))
				.map((item) => ({
					taskId: item.taskId,
					outcome: item.outcome,
					summary: item.summary.slice(0, TASK_DELIVERY_PREVIEW_CHARS),
					evidenceRefs: item.evidenceRefs,
				})),
			claims: snapshot.executionFrame.frame.facts.map((item) => ({
				key: item.key,
				evidenceRefs: item.evidenceRefs,
				sourceTaskId: item.sourceTaskId,
				status: "executor_claim",
				value:
					JSON.stringify(item.value).length <= 512
						? item.value
						: "Detailed delivery omitted; request the specific finding from an executor",
			})),
			failureBoundaries: snapshot.executionFrame.frame.rejectedDirections,
			openQuestions: snapshot.executionFrame.frame.openQuestions,
			artifacts: snapshot.executionFrame.frame.artifacts,
		},
		checkpoint: snapshot.latestCheckpoint
			? {
					taskId: snapshot.latestCheckpoint.taskId,
					checkpointId: snapshot.latestCheckpoint.checkpointId,
					summary: snapshot.latestCheckpoint.summary.slice(0, TASK_DELIVERY_PREVIEW_CHARS),
					evidenceRefs: snapshot.latestCheckpoint.evidenceRefs,
					artifacts: snapshot.latestCheckpoint.artifacts,
					remainingItems: snapshot.latestCheckpoint.remainingItems,
				}
			: undefined,
		evidenceIndex: snapshot.evidence
			.filter((item, index) => evidenceIds.has(item.evidenceId) || index >= snapshot.evidence.length - 32)
			.map((item) => ({
				evidenceId: item.evidenceId,
				sourceTaskId: item.taskId,
				sourceHash: item.contentHash,
				toolName: item.toolName,
				summary:
					latestCardSummaries.get(item.evidenceId) ??
					"No semantic card published; ask an executor for the specific missing finding.",
				isError: item.metadata.isError === true,
			})),
		limits: { unresolvedPerPath: 2, unresolvedTotal: 4 },
	};
}

export function parseHypothesisProposal(value: unknown, snapshot: PlanningSnapshot): PlanningPlanProposal {
	const normalized = fillHostPlanningFields(value, snapshot.run.revision) as Record<string, unknown>;
	// The human goal is already passed to every executor. It is a valid hypothesis
	// basis, but is not an input evidence ID or a produced artifact dependency.
	if (Array.isArray(normalized.tasks)) {
		for (const task of normalized.tasks as Record<string, unknown>[]) {
			if (Array.isArray(task.inputEvidenceRefs))
				task.inputEvidenceRefs = task.inputEvidenceRefs.filter((id) => id !== "human:goal");
			if (Array.isArray(task.requiredInputs)) {
				task.requiredInputs = task.requiredInputs
					.filter((input) => !(input?.evidenceId === "human:goal" && !input.artifactPath))
					.map((input) => {
						if (!input || typeof input !== "object" || input.sourceTaskId || !input.evidenceId) return input;
						const source = snapshot.evidence.find((item) => item.evidenceId === input.evidenceId);
						return source ? { ...input, sourceTaskId: source.taskId } : input;
					});
			}
		}
	}
	let proposal: PlanningPlanProposal;
	try {
		proposal = parsePlanningPlanProposal(JSON.stringify(normalized), snapshot.run.revision);
	} catch (error) {
		if (isPlanningFailureError(error)) throw error;
		throw new HypothesisInputError(
			"hypothesis_proposal_invalid",
			error instanceof Error ? error.message : "Invalid plan proposal",
			["decision", "tasks"],
		);
	}
	const newValues = normalized.newHypotheses;
	if (!Array.isArray(newValues) || newValues.length > 4)
		throw new HypothesisInputError("hypothesis_proposal_invalid", "newHypotheses must be a bounded array", [
			"newHypotheses",
		]);
	const ids = new Map<string, string>();
	for (const raw of newValues) {
		if (!raw || typeof raw !== "object" || typeof raw.key !== "string" || !raw.key.trim() || ids.has(raw.key))
			throw new HypothesisInputError("hypothesis_proposal_invalid", "Unique nonempty hypothesis keys required", [
				"newHypotheses[].key",
			]);
		ids.set(raw.key, hypothesisId(snapshot.run.runId, raw.key));
	}
	const resolve = (id: string) => ids.get(id) ?? id;
	const update: HypothesisGraphUpdate = {
		expectedVersion: snapshot.hypothesisGraph?.version ?? 0,
		newNodes: newValues.map((raw) => {
			for (const field of ["statement", "verificationCriteria", "refutationCriteria"])
				if (typeof raw[field] !== "string" || !raw[field].trim() || raw[field].length > 1000)
					throw new HypothesisInputError("hypothesis_proposal_invalid", `Invalid hypothesis ${field}`, [
						`newHypotheses[].${field}`,
					]);
			for (const field of ["basisRefs", "parentHypothesisIds"])
				if (
					!Array.isArray(raw[field]) ||
					raw[field].length > 32 ||
					raw[field].some((id: unknown) => typeof id !== "string")
				)
					throw new HypothesisInputError("hypothesis_proposal_invalid", `Invalid hypothesis ${field}`, [
						`newHypotheses[].${field}`,
					]);
			return {
				id: ids.get(raw.key)!,
				statement: raw.statement,
				status: "pending",
				basisRefs: raw.basisRefs,
				parentHypothesisIds: raw.parentHypothesisIds.map(resolve),
				verificationCriteria: raw.verificationCriteria,
				refutationCriteria: raw.refutationCriteria,
				verificationEvidenceRefs: [],
				needsReview: false,
			};
		}),
		newBindings: [],
	};
	const taskValues = normalized.tasks as Record<string, unknown>[];
	const taskIds = new Map(
		proposal.tasks.map((task) => [task.key, stablePlanningTaskId(snapshot.run.runId, task.key)]),
	);
	update.newBindings = proposal.tasks.map((task, index) => {
		const raw = taskValues[index];
		if (!Array.isArray(raw.hypothesisIds) || raw.hypothesisIds.some((id) => typeof id !== "string"))
			throw new HypothesisInputError("hypothesis_proposal_invalid", "Every task requires hypothesisIds", [
				`tasks[${index}].hypothesisIds`,
			]);
		if (!["test_hypothesis", "gather_evidence", "verify_goal", "review_basis"].includes(String(raw.purpose)))
			throw new HypothesisInputError("hypothesis_proposal_invalid", "Task purpose required", [
				`tasks[${index}].purpose`,
			]);
		const inputs = raw.requiredInputs ?? [];
		if (!Array.isArray(inputs) || inputs.length > 16)
			throw new HypothesisInputError("hypothesis_proposal_invalid", "Invalid requiredInputs", [
				`tasks[${index}].requiredInputs`,
			]);
		return {
			taskId: taskIds.get(task.key)!,
			hypothesisIds: raw.hypothesisIds.map((id) => resolve(String(id))),
			purpose: raw.purpose as "test_hypothesis" | "gather_evidence" | "verify_goal" | "review_basis",
			requiredInputs: inputs.map((input) => ({
				sourceTaskId: taskIds.get(input.sourceTaskId) ?? input.sourceTaskId,
				...(typeof input.artifactPath === "string" ? { artifactPath: input.artifactPath } : {}),
				...(typeof input.evidenceId === "string" ? { evidenceId: input.evidenceId } : {}),
			})),
		};
	});
	if (proposal.decision === "create_tasks" && !proposal.tasks.length)
		throw new HypothesisInputError("hypothesis_proposal_invalid", "create_tasks requires work", ["tasks"]);
	if (proposal.decision !== "create_tasks" && (proposal.tasks.length || newValues.length))
		throw new HypothesisInputError(
			"hypothesis_proposal_invalid",
			"Waiting/completion cannot introduce unassigned hypotheses or tasks",
			["tasks", "newHypotheses"],
		);
	if (proposal.decision === "blocked" && !(snapshot.activeLeases?.length || snapshot.activeLease))
		throw new HypothesisInputError(
			"hypothesis_wait_invalid",
			"Cannot wait without a live owner; propose concrete evidence gathering or testing work",
			["waitForTaskIds"],
		);
	if (proposal.decision === "blocked") {
		const owners = new Set(
			(snapshot.activeLeases ?? (snapshot.activeLease ? [snapshot.activeLease] : [])).map((lease) => lease.taskId),
		);
		const waiting = normalized.waitForTaskIds;
		if (!Array.isArray(waiting) || !waiting.length || waiting.some((id) => typeof id !== "string" || !owners.has(id)))
			throw new HypothesisInputError(
				"hypothesis_wait_invalid",
				"Waiting must reference specific currently live task owners",
				["waitForTaskIds"],
			);
		proposal.hypothesisWaitingTaskIds = waiting;
	}
	validatePlanningDependencies(proposal, snapshot);
	const compiled = compilePlanningProposal(snapshot.run.runId, proposal, snapshot.tasks, Number.MAX_SAFE_INTEGER);
	applyHypothesisUpdate(
		snapshot.hypothesisGraph ?? emptyHypothesisGraph(),
		update,
		snapshot,
		compiled.map((task) => task.taskId),
		compiled,
	);
	proposal.hypothesisUpdate = update;
	return proposal;
}

export class HypothesisPlanningSupervisor implements PlanningSupervisor {
	private readonly options: PiPlanningAdapterOptions;
	constructor(options: PiPlanningAdapterOptions) {
		this.options = options;
	}
	async propose(input: Parameters<PlanningSupervisor["propose"]>[0]): Promise<PlanningPlanProposal> {
		const runId = input.snapshot.run.runId;
		const startedAt = Date.now();
		const emit = (type: string, payload: Record<string, unknown> = {}) =>
			this.options.onLifecycleEvent?.(type, {
				...payload,
				runId,
				engine: "hypothesis",
				elapsedMs: Date.now() - startedAt,
			});
		emit("supervisor_propose_start", { graphVersion: input.snapshot.hypothesisGraph?.version ?? 0 });
		try {
			const result = await generatePlanningProposal({
				...this.options,
				signal: input.signal,
				outputSchema: hypothesisProposalSchema,
				onLifecycleEvent: (type, payload = {}) =>
					this.options.onLifecycleEvent?.(type, { ...payload, runId, engine: "hypothesis" }),
				task: [
					input.changes
						? `Changes since the last accepted review (exact current-run IDs): ${JSON.stringify(planningChangesOverview(input.changes))}`
						: "",
					"Plan a bounded hypothesis DAG from the evidence blackboard, current task graph and human prompt. Treat human constraints as constraints, and human guesses as unverified. Submit one short structured decision, without drafts or raw tool investigation.",
					"Every derivation path permits at most two unresolved hypotheses; the whole graph permits four. Reuse IDs. A verified claim is local, not proof of whole-goal success. You cannot mark a hypothesis verified/refuted.",
					"Use basisRefs pointing to actual evidence IDs, existing task IDs with deliveries, or human:goal. human:goal belongs only in basisRefs: inputEvidenceRefs accepts persisted evidence IDs; requiredInputs describes produced inputs, not the human goal. Omit requiredInputs when no produced input is needed. Its sourceTaskId can be omitted for a known evidenceId; the host resolves the producer. parentHypothesisIds represent inference, not task completion gates. Keep end-to-end ownership of the critical path and use independent side work when useful; simple tasks may use one executor.",
					"Task dependsOn references actual required completion only. For partial artifacts use requiredInputs={sourceTaskId,artifactPath}; for already available observations use inputEvidenceRefs. Never wait for a full report if the necessary checkpoint artifact is available. Raw evidence tools are not exposed to you: request a specific missing finding from a worker, which may read original records without repeating execution.",
					"Bind each task to hypothesisIds and purpose. gather_evidence may have no hypothesis when acquiring missing facts. verify_goal is only for concrete final verification. Explain missing information precisely. Do not invent filler to occupy a second slot. A blocked decision requires waitForTaskIds naming specific live owners, and a rationale explaining their coverage or dependency. Observer statements are suggestions, not verified evidence. Use review_basis to reassess contradictory observations or downstream premises; retain both original and new evidence. A revised executor verdict must cite the prior verificationEvidenceRefs in reviewOfEvidenceRefs.",
					`Scheduling: ${JSON.stringify(input.scheduling ?? {})}. Previous validation issue: ${JSON.stringify(input.recovery ?? null)}.`,
					`Observer suggestions (unverified): ${JSON.stringify(this.options.runObserver?.overview() ?? [])}`,
					`Current role view:\n${JSON.stringify(hypothesisPlannerView(input.snapshot))}`,
				].join("\n\n"),
				nativeSession: {
					queryContext: false,
					readonlyContext: {
						run: input.snapshot.run,
						changes: input.changes ? planningChangesOverview(input.changes) : undefined,
					},
					normalizeSubmission: (value) => fillHostPlanningFields(value, input.snapshot.run.revision),
					validateSubmission: (value) => {
						parseHypothesisProposal(value, input.snapshot);
					},
				},
			});
			const proposal = parseHypothesisProposal(JSON.parse(result.finalText), input.snapshot);
			emit("supervisor_propose_end", {
				decision: proposal.decision,
				taskCount: proposal.tasks.length,
				hypothesisCount: proposal.hypothesisUpdate?.newNodes.length ?? 0,
				outputChars: result.finalText.length,
			});
			return proposal;
		} catch (error) {
			emit("supervisor_propose_end", {
				isError: true,
				error: error instanceof Error ? error.message : String(error),
			});
			if (input.signal?.aborted || isPlanningFailureError(error)) throw error;
			throw planningFailure(
				"proposal_validation",
				"proposal_validation_error",
				error instanceof Error ? error.message : String(error),
				error,
				runId,
			);
		}
	}
}

export function hypothesisExecutorExtension(
	store: PlanningStore,
	scope: PlanningChildScope,
	evidenceCatalogEnabled = true,
): InlineExtension {
	return {
		name: "hypothesis-blackboard",
		factory(pi) {
			pi.on("tool_result", (event) => {
				if (event.toolName !== "hypothesis_publish_observation") return;
				const details = event.details as { reasonCode?: string } | undefined;
				if (HYPOTHESIS_INPUT_CODES.some((code) => code === details?.reasonCode)) return { isError: true };
			});
			pi.registerTool({
				name: "hypothesis_read_board",
				label: "Read hypothesis board",
				description:
					"Read current hypothesis state and task bindings; raw evidence remains available through planning_read_evidence.",
				parameters: Type.Object({}),
				execute: async () => ({
					content: [{ type: "text", text: JSON.stringify(store.getHypothesisGraphForLease(scope.leaseId)) }],
					details: {},
				}),
			});
			pi.registerTool({
				name: "hypothesis_publish_observation",
				label: "Publish evidence card",
				description:
					"Persist a semantic evidence card and explicit criterion-based verdict for assigned hypotheses. A tool failure means undetermined. This never stops an executor or verifies the whole goal.",
				parameters: hypothesisObservationSchema,
				execute: async (_id, args): Promise<AgentToolResult<unknown>> => {
					const observation: HypothesisObservation = {
						...args,
						expectedVersion: args.expectedVersion ?? store.getHypothesisGraphForLease(scope.leaseId).version,
						resolutions: args.resolutions ?? [],
					};
					try {
						const graph = store.publishHypothesisObservation(scope.leaseId, observation);
						const card = graph.cards.find((item) => item.id === evidenceCardId(scope.leaseId, args.card))!;
						scope.onProgress?.();
						const result = {
							version: graph.version,
							status: "persisted",
							cardId: card.id,
							evidenceRefs: card.evidenceRefs,
							hypothesisIds: observation.resolutions.map((item) => item.hypothesisId),
							goalVerified: false,
						};
						return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
					} catch (error) {
						if (!(error instanceof HypothesisInputError)) throw error;
						const result = {
							status: "rejected",
							reasonCode: error.code,
							fieldPaths: error.fieldPaths,
							message: error.message,
							retryable: true,
							nextTool: {
								name:
									error.code === "hypothesis_unknown_evidence" && evidenceCatalogEnabled
										? "planning_list_evidence"
										: "hypothesis_read_board",
								arguments: {},
							},
						};
						return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
					}
				},
			});
		},
	};
}

export function hypothesisExecutorContext(snapshot: PlanningSnapshot, taskId: string): string {
	const graph = snapshot.hypothesisGraph ?? emptyHypothesisGraph();
	const originalBinding = graph.taskBindings.find((item) => item.taskId === taskId);
	const binding = originalBinding
		? {
				...originalBinding,
				requiredInputs: originalBinding.requiredInputs.map((input) => {
					if (!input.artifactPath) return input;
					const resolved = resolveHypothesisArtifactInput(graph, snapshot, input);
					return resolved.kind === "resolved" ? { ...input, artifactPath: resolved.artifactPath } : input;
				}),
			}
		: undefined;
	const relevant = new Set(binding?.hypothesisIds ?? []);
	for (const node of graph.nodes)
		if (relevant.has(node.id) || node.parentHypothesisIds.some((id) => relevant.has(id))) {
			relevant.add(node.id);
			for (const parent of node.parentHypothesisIds) relevant.add(parent);
		}
	return `# Hypothesis execution view\n${JSON.stringify({ version: graph.version, binding, nodes: graph.nodes.filter((node) => relevant.has(node.id)), otherBranches: graph.nodes.filter((node) => !relevant.has(node.id)).map((node) => ({ id: node.id, statement: node.statement, status: node.status })), cards: graph.cards })}\nUse hypothesis_read_board before publishing to get the latest version. Publish 30–50 character semantic evidence cards at useful checkpoints with exact keyValues, scope, limitations and original evidence IDs. Explicitly justify each assigned hypothesis verdict against its criterion; local task completion is not hypothesis verification. Continue through solving and native goal verification. Preserve raw records and unfinished tools; never stop just because a hypothesis was refuted.`;
}
