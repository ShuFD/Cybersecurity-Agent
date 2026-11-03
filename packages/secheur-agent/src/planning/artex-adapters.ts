import type { AgentToolResult, InlineExtension } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	ARTEX_DEBOUNCE_MS,
	ARTEX_HEARTBEAT_MS,
	ArtexInputError,
	applyArtexPlan,
	artexGraphView,
	artexId,
	artexObservationHash,
	createArtexGraph,
} from "./artex-graph.ts";
import type { ArtexGraph, ArtexObservation, ArtexPlanUpdate } from "./artex-types.ts";
import { compilePlanningProposal } from "./compiler.ts";
import {
	type PlanningPlanProposal,
	type PlanningSnapshot,
	parsePlanningPlanProposal,
	stablePlanningTaskId,
	validatePlanningDependencies,
} from "./contracts.ts";
import { isPlanningFailureError, planningFailure } from "./failures.ts";
import type { PlanningSupervisor } from "./harness.ts";
import type { PiPlanningAdapterOptions, PlanningChildScope } from "./pi-adapters.ts";
import { generatePlanningProposal } from "./proposal-model.ts";
import { fillHostPlanningFields } from "./proposal-session.ts";
import { planningChangesOverview } from "./review-changes.ts";
import { sharedVerificationHistory } from "./shared-feedback.ts";
import type { PlanningStore } from "./store.ts";
import { trustedPlanningVerificationFromSnapshot } from "./terminal-verification.ts";

const refs = Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 });
const text = Type.String({ minLength: 1, maxLength: 2000 });
export const artexObservationSchema = Type.Object(
	{
		key: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
		kind: Type.Optional(Type.Union([Type.Literal("fact"), Type.Literal("finding")])),
		payload: text,
		confidence: Type.Optional(Type.Union([Type.Literal("observed"), Type.Literal("inferred")])),
		evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 64 }),
		parentIds: Type.Optional(refs),
		anchors: Type.Optional(refs),
		assets: Type.Optional(Type.Array(Type.Object({ key: text, type: text, label: text }), { maxItems: 32 })),
		assetEdges: Type.Optional(
			Type.Array(Type.Object({ source: text, target: text, relation: text }), { maxItems: 32 }),
		),
	},
	{ additionalProperties: false },
);
export const artexProposalSchema = Type.Object(
	{
		decision: Type.Union([Type.Literal("create_tasks"), Type.Literal("blocked"), Type.Literal("finish_run")]),
		rationale: text,
		todo: Type.String({ maxLength: 8000 }),
		tasks: Type.Array(
			Type.Object(
				{
					key: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
					objective: text,
					doneWhen: text,
					priority: Type.Optional(Type.Integer({ minimum: -1000, maximum: 1000 })),
					parentIds: Type.Optional(refs),
					anchors: Type.Optional(refs),
					dependsOn: Type.Optional(refs),
					inputEvidenceRefs: Type.Optional(refs),
				},
				{ additionalProperties: false },
			),
		),
		hints: Type.Optional(
			Type.Array(
				Type.Object(
					{
						key: Type.String({ minLength: 1, maxLength: 120 }),
						payload: text,
						parentIds: Type.Optional(refs),
						evidenceRefs: Type.Optional(refs),
					},
					{ additionalProperties: false },
				),
			),
		),
		waitForTaskIds: Type.Optional(refs),
		answerEvidenceRefs: Type.Optional(refs),
	},
	{ additionalProperties: false },
);

export function parseArtexProposal(value: unknown, snapshot: PlanningSnapshot): PlanningPlanProposal {
	if (!Value.Check(artexProposalSchema, value))
		throw new ArtexInputError("artex_proposal_invalid", "Invalid Artex proposal shape", ["proposal"]);
	const raw = value as Static<typeof artexProposalSchema>;
	const normalized = fillHostPlanningFields(raw, snapshot.run.revision) as typeof raw;
	const proposal = parsePlanningPlanProposal(JSON.stringify(normalized), snapshot.run.revision);
	const graph = snapshot.artexGraph ?? createArtexGraph(snapshot.run.runId, snapshot.run.goal);
	const aliases = new Map(
		normalized.tasks.map((task) => [
			task.key!,
			artexId(graph.runId, "intent", stablePlanningTaskId(graph.runId, task.key!)),
		]),
	);
	const update: ArtexPlanUpdate = {
		expectedRound: graph.round,
		observedVersion: graph.version,
		todo: raw.todo,
		intents: normalized.tasks.map((task) => ({
			taskId: stablePlanningTaskId(graph.runId, task.key!),
			parentIds: (task.parentIds?.length ? task.parentIds : [artexId(graph.runId, "goal", "goal")]).map(
				(id) => aliases.get(id) ?? id,
			),
			anchors: task.anchors ?? [],
		})),
		hints: (raw.hints ?? []).map((hint) => ({
			...hint,
			parentIds: hint.parentIds ?? [],
			evidenceRefs: hint.evidenceRefs ?? [],
		})),
	};
	if (proposal.decision === "create_tasks" && !proposal.tasks.length)
		throw new ArtexInputError(
			"artex_proposal_invalid",
			"Create at least one runnable intent or explicitly wait for its owner",
			["tasks"],
		);
	if (proposal.decision !== "create_tasks" && proposal.tasks.length)
		throw new ArtexInputError("artex_proposal_invalid", "Waiting or finishing cannot create tasks", [
			"decision",
			"tasks",
		]);
	if (proposal.decision === "blocked") {
		const owners = new Set((snapshot.activeLeases ?? []).map((lease) => lease.taskId));
		if (!raw.waitForTaskIds?.length || raw.waitForTaskIds.some((id) => !owners.has(id)))
			throw new ArtexInputError(
				"artex_owner_required",
				"Waiting requires specific live owners; otherwise propose a runnable next intent",
				["waitForTaskIds"],
			);
		proposal.artexWaitingTaskIds = raw.waitForTaskIds;
	}
	if (proposal.decision === "finish_run" && !trustedPlanningVerificationFromSnapshot(snapshot))
		throw new ArtexInputError(
			"artex_native_verification_required",
			"Only persisted native verifier evidence proves the goal",
			["answerEvidenceRefs"],
		);
	validatePlanningDependencies(proposal, snapshot);
	const tasks = compilePlanningProposal(graph.runId, proposal, snapshot.tasks, Number.MAX_SAFE_INTEGER);
	applyArtexPlan(graph, update, snapshot, tasks);
	proposal.artexUpdate = update;
	return proposal;
}

export function artexPlannerView(snapshot: PlanningSnapshot, budget = 16384) {
	budget = Math.max(1024, budget);
	const graph = artexGraphView(snapshot.artexGraph ?? createArtexGraph(snapshot.run.runId, snapshot.run.goal));
	const ordered = [...graph.nodes].sort((left, right) => {
		const rank = (kind: string, state: string) =>
			kind === "goal" || ["open", "running", "paused", "origin"].includes(state)
				? 0
				: kind === "finding" || kind === "hint"
					? 1
					: 2;
		return rank(left.kind, left.state) - rank(right.kind, right.state) || right.createdRound - left.createdRound;
	});
	const nodes: typeof graph.nodes = [];
	let bytes = 0;
	for (const item of ordered) {
		const compact = { ...item, payload: item.payload.slice(0, 320) };
		const size = Buffer.byteLength(JSON.stringify(compact));
		if (bytes + size > budget) continue;
		nodes.push(compact);
		bytes += size;
	}
	const view = {
		runId: graph.runId,
		version: graph.version,
		round: graph.round,
		todo: graph.todo,
		nodes,
		edges: [] as typeof graph.edges,
		omittedNodeCount: graph.nodes.length - nodes.length,
		foldedNodeCount: graph.foldedNodeCount,
		activeIntentCount: graph.nodes.filter(
			(item) => item.kind === "intent" && ["open", "running", "paused"].includes(item.state),
		).length,
		verificationHistory: sharedVerificationHistory(snapshot.evidence),
	};
	for (;;) {
		const ids = new Set(view.nodes.map((item) => item.id));
		view.edges = graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
		view.omittedNodeCount = graph.nodes.length - view.nodes.length;
		if (Buffer.byteLength(JSON.stringify(view)) <= budget) return view;
		if (view.nodes.length) view.nodes.pop();
		else if (view.verificationHistory.length) view.verificationHistory.shift();
		else if (view.todo.length) view.todo = view.todo.slice(0, Math.floor(view.todo.length / 2));
		else throw new Error("Graph identity exceeds the context budget");
	}
}

export class ArtexPlanningSupervisor implements PlanningSupervisor {
	readonly eventPolicy = { debounceMs: ARTEX_DEBOUNCE_MS, heartbeatMs: ARTEX_HEARTBEAT_MS };
	private readonly options: PiPlanningAdapterOptions;
	constructor(options: PiPlanningAdapterOptions) {
		this.options = options;
	}

	async propose(input: Parameters<PlanningSupervisor["propose"]>[0]): Promise<PlanningPlanProposal> {
		const { snapshot } = input;
		const graph = snapshot.artexGraph ?? createArtexGraph(snapshot.run.runId, snapshot.run.goal);
		const emit = (type: string, payload: Record<string, unknown> = {}) =>
			this.options.onLifecycleEvent?.(type, { ...payload, runId: graph.runId, engine: "artex" });
		const view = artexPlannerView(snapshot, this.options.config.planning.maxEvidenceBytes);
		emit("supervisor_propose_start", { graphVersion: graph.version, round: graph.round });
		emit("planning_context_rendered", {
			role: "supervisor",
			presentedNodeIds: view.nodes.map((item) => item.id),
			omittedNodeCount: view.omittedNodeCount,
		});
		try {
			const result = await generatePlanningProposal({
				...this.options,
				signal: input.signal,
				onLifecycleEvent: emit,
				outputSchema: artexProposalSchema,
				task: [
					input.changes
						? `Changes since the last accepted review (exact current-run IDs): ${JSON.stringify(planningChangesOverview(input.changes))}`
						: "",
					"Plan using the Artex exploration graph. You alone create intents; workers own their execution. Graph edges point upstream to downstream: spawns, derived_from, yields, proves, covers. Causal parentIds describe provenance, NOT execution dependencies. Only dependsOn delays execution.",
					"Reuse open/running intents instead of redispatching their work. Keep a runnable end-to-end owner through native verification, with independent auxiliary work only when useful. Workers continue across local steps and may publish partial evidence without ending the intent. Do not split a continuous investigation just to populate slots.",
					"Use priority to order the open frontier. Set parentIds to existing goal, fact, finding, hint or intent IDs. Omission uses the overall goal. Preserve evidenceRefs and asset anchors. Facts are observations or inferences, findings are worker conclusions, hints are planner suggestions, and neither is whole-goal proof.",
					"On each event or heartbeat, consider new findings and completed/blocked intents, update the durable todo, and submit one decision. Zero new intents is valid as blocked with waitForTaskIds naming live owners and rationale describing coverage. With no live owner and an unverified goal, create runnable work. Only native verification permits finish_run.",
					"The overview is bounded and cold settled branches are digest views. Original nodes, edges, assets, evidence IDs, tasks and checkpoints remain available through planning_query_context sections. Read exact IDs as needed; never fabricate references or treat omission as deletion. New hints must cite real evidence when claiming an observation.",
					`Goal: ${snapshot.run.goal}`,
					`Scheduling: ${JSON.stringify(input.scheduling ?? {})}. Recovery: ${JSON.stringify(input.recovery ?? null)}.`,
					`Current live owner task IDs: ${JSON.stringify((snapshot.activeLeases ?? []).map((lease) => lease.taskId))}. If existing owners cover the next work, a short blocked decision with tasks:[], waitForTaskIds, todo and rationale is sufficient; hints are optional.`,
					`Graph overview: ${JSON.stringify(view)}`,
				].join("\n\n"),
				nativeSession: {
					queryContext: true,
					readonlyContext: {
						run: snapshot.run,
						changes: input.changes ? planningChangesOverview(input.changes) : undefined,
						nodes: graph.nodes,
						edges: graph.edges,
						assets: graph.assets,
						assetEdges: graph.assetEdges,
						digests: artexGraphView(graph).digests,
						tasks: snapshot.tasks,
						evidence: snapshot.evidence.map((item) => ({
							evidenceId: item.evidenceId,
							taskId: item.taskId,
							summary: item.summary,
						})),
						checkpoints: snapshot.latestCheckpoint ? [snapshot.latestCheckpoint] : [],
					},
					validateSubmission: (value) => {
						parseArtexProposal(value, snapshot);
					},
				},
			});
			const proposal = parseArtexProposal(JSON.parse(result.finalText), snapshot);
			emit("supervisor_propose_end", { decision: proposal.decision, taskCount: proposal.tasks.length });
			return proposal;
		} catch (error) {
			emit("supervisor_propose_end", { isError: true });
			if (input.signal?.aborted || isPlanningFailureError(error)) throw error;
			throw planningFailure(
				"proposal_validation",
				"proposal_validation_error",
				error instanceof Error ? error.message : String(error),
				error,
				graph.runId,
			);
		}
	}
}

export function artexWorkerView(graph: ArtexGraph, taskId: string, maximumBytes = 16384) {
	const own = graph.nodes.find((item) => item.sourceTaskId === taskId && item.kind === "intent");
	const ancestors = new Set(own ? [own.id] : []);
	const queue = [...ancestors];
	for (let index = 0; index < queue.length; index++)
		for (const edge of graph.edges)
			if (
				!["covers", "proves"].includes(edge.relation) &&
				edge.target === queue[index] &&
				!ancestors.has(edge.source)
			) {
				ancestors.add(edge.source);
				queue.push(edge.source);
			}
	const related = new Set(graph.edges.filter((edge) => edge.source === own?.id).map((edge) => edge.target));
	const ordered = [...graph.nodes]
		.sort((left, right) => {
			const rank = (id: string) => (id === own?.id ? 0 : ancestors.has(id) ? 1 : related.has(id) ? 2 : 3);
			return rank(left.id) - rank(right.id) || right.createdAt - left.createdAt;
		})
		.filter(
			(item) => ancestors.has(item.id) || related.has(item.id) || ["fact", "finding", "hint"].includes(item.kind),
		);
	const view = {
		version: graph.version,
		intentId: own?.id,
		nodes: [] as {
			id: string;
			kind: string;
			state: string;
			payload: string;
			evidenceRefs: string[];
			anchors: string[];
			sourceTaskId?: string;
		}[],
		edges: [] as typeof graph.edges,
		omittedNodeCount: ordered.length,
	};
	for (const item of ordered) {
		const candidate = {
			id: item.id,
			kind: item.kind,
			state: item.state,
			payload: item.payload.slice(0, 600),
			evidenceRefs: item.evidenceRefs,
			anchors: item.anchors,
			sourceTaskId: item.sourceTaskId,
		};
		view.nodes.push(candidate);
		const ids = new Set(view.nodes.map((entry) => entry.id));
		const previousEdges = view.edges;
		view.edges = graph.edges.filter(
			(edge) => edge.relation !== "covers" && ids.has(edge.source) && ids.has(edge.target),
		);
		if (Buffer.byteLength(JSON.stringify(view)) > Math.max(1024, maximumBytes)) {
			view.nodes.pop();
			view.edges = previousEdges;
		}
	}
	view.omittedNodeCount = ordered.length - view.nodes.length;
	return view;
}

export function artexExecutorExtension(
	store: PlanningStore,
	scope: PlanningChildScope,
	maximumBytes = 16384,
): InlineExtension {
	return {
		name: "artex-exploration-graph",
		factory(pi) {
			pi.on("tool_result", (event) => {
				if (
					(event.toolName === "artex_publish_observation" || event.toolName === "artex_read_graph") &&
					(event.details as { retryable?: boolean } | undefined)?.retryable
				)
					return { isError: true };
				return undefined;
			});
			pi.on("context", (event) => {
				const graph = store.getArtexGraphForLease(scope.leaseId);
				return {
					messages: [
						{
							role: "user" as const,
							content: `[Artex live graph]\n${JSON.stringify(artexWorkerView(graph, scope.taskId, maximumBytes))}\nRead exact graph nodes and evidence as needed. Shared claims retain their provenance.`,
							timestamp: Date.now(),
						},
						...event.messages,
					],
				};
			});
			pi.registerTool({
				name: "artex_read_graph",
				label: "Read exploration graph",
				description:
					"Read the current run's graph, including original nodes hidden behind digests. Supports bounded pages.",
				parameters: Type.Object({
					id: Type.Optional(Type.String()),
					offset: Type.Optional(Type.Integer({ minimum: 0 })),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8192 })),
				}),
				execute: async (_callId, args): Promise<AgentToolResult<Record<string, unknown>>> => {
					const graph = store.getArtexGraphForLease(scope.leaseId);
					const selected = args.id
						? (graph.nodes.find((item) => item.id === args.id) ??
							graph.assets.find((item) => item.id === args.id))
						: artexGraphView(graph);
					if (!selected) {
						const details = {
							reasonCode: "artex_graph_reference_not_found",
							fieldPaths: ["id"],
							retryable: true,
						};
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										status: "not_found",
										...details,
										message:
											"Call artex_read_graph without id to list current graph IDs, then use an exact returned id.",
									}),
								},
							],
							details,
						};
					}
					const text = JSON.stringify(selected);
					const offset = args.offset ?? 0;
					const end = Math.min(text.length, offset + (args.limit ?? 4096));
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									text: text.slice(offset, end),
									totalChars: text.length,
									nextOffset: end < text.length ? end : null,
								}),
							},
						],
						details: {},
					};
				},
			});
			pi.registerTool({
				name: "artex_publish_observation",
				label: "Publish graph observation",
				description:
					"Publish an evidence-backed fact or finding to the shared graph. Use complete persisted successful tool evidence IDs from this run; references are never guessed or filled from recent output. Omit key for a stable host-generated key; kind defaults to fact and confidence to inferred. Reuse an explicit key only for an identical retry. This does not finish the intent or verify the goal.",
				parameters: artexObservationSchema,
				execute: async (_callId, args): Promise<AgentToolResult<Record<string, unknown>>> => {
					const input: ArtexObservation = {
						...args,
						key: args.key ?? "",
						kind: args.kind ?? "fact",
						confidence: args.confidence ?? "inferred",
						evidenceRefs: [...new Set(args.evidenceRefs)].sort(),
					};
					input.key ||= `observation-${artexObservationHash(input).slice(0, 24)}`;
					const before = store.getArtexGraphForLease(scope.leaseId);
					const nodeId = artexId(before.runId, input.kind, `${scope.taskId}:${input.key}`);
					const duplicate = before.nodes.some((item) => item.id === nodeId);
					let graph: ArtexGraph;
					try {
						graph = store.publishArtexObservation(scope.leaseId, input);
					} catch (error) {
						if (!(error instanceof ArtexInputError)) throw error;
						const details = { reasonCode: error.code, fieldPaths: error.fieldPaths, retryable: true };
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify({ status: "rejected", ...details, message: error.message }),
								},
							],
							details,
						};
					}
					const observation = graph.nodes.find((item) => item.id === nodeId)!;
					const details = {
						status: duplicate ? "duplicate" : "persisted",
						nodeId: observation.id,
						evidenceRefs: observation.evidenceRefs,
						version: graph.version,
						goalVerified: false,
					};
					scope.onProgress?.();
					return { content: [{ type: "text", text: JSON.stringify(details) }], details };
				},
			});
		},
	};
}

export function artexExecutorContext(snapshot: PlanningSnapshot, taskId: string): string {
	const graph = snapshot.artexGraph;
	return `# Artex worker\n${JSON.stringify(graph?.nodes.find((item) => item.kind === "intent" && item.sourceTaskId === taskId))}\nOwn this intent continuously through the requested deliverable. Publish useful intermediate facts/findings with artex_publish_observation using real evidence IDs and optional asset anchors. Read the current graph before repeating another worker's work. Use planning_checkpoint for usable artifacts and handoff. Do not create intents, mark goals met, or stop on a local finding; the host owns leasing and final verification.`;
}
