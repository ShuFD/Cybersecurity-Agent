import { createHash } from "node:crypto";
import type { ArtexGraph, ArtexNode, ArtexObservation, ArtexPlanUpdate, ArtexState } from "./artex-types.ts";
import type { PlanningSnapshot, PlanningTaskStatus } from "./contracts.ts";
import { PlanningFailureError } from "./failures.ts";
import type { CompiledPlanningTask } from "./store.ts";
import { trustedPlanningVerificationFromSnapshot } from "./terminal-verification.ts";

export const ARTEX_COLD_ROUNDS = 6;
export const ARTEX_MIN_FOLD_SIZE = 2;
export const ARTEX_DEBOUNCE_MS = 800;
export const ARTEX_HEARTBEAT_MS = 600_000;

export const ARTEX_INPUT_FAILURE_CODES = [
	"artex_proposal_invalid",
	"artex_owner_required",
	"artex_native_verification_required",
	"artex_duplicate_reference",
	"artex_observation_invalid",
	"artex_evidence_required",
	"artex_unknown_reference",
	"artex_observation_key_conflict",
	"artex_asset_conflict",
	"artex_graph_reference_not_found",
] as const;

export class ArtexInputError extends PlanningFailureError {
	readonly fieldPaths: string[];

	constructor(code: (typeof ARTEX_INPUT_FAILURE_CODES)[number], message: string, fieldPaths: string[]) {
		super({ source: "planning", stage: "proposal_validation", code, message });
		this.name = "ArtexInputError";
		this.fieldPaths = fieldPaths;
	}
}

export function artexId(runId: string, kind: string, key: string): string {
	return `artex-${kind}-${createHash("sha256").update(`${runId}\0${kind}\0${key}`).digest("hex").slice(0, 24)}`;
}

function node(
	graph: ArtexGraph,
	key: string,
	kind: ArtexNode["kind"],
	payload: string,
	state: ArtexState,
	origin: ArtexNode["origin"],
	now: number,
): ArtexNode {
	return {
		id: artexId(graph.runId, kind, key),
		kind,
		payload,
		state,
		origin,
		priority: 0,
		anchors: [],
		evidenceRefs: [],
		inherited: false,
		createdAt: now,
		createdRound: graph.round,
		lastActiveRound: graph.round,
	};
}

export function createArtexGraph(runId: string, goal: string, now = Date.now()): ArtexGraph {
	const graph: ArtexGraph = {
		schemaVersion: 1,
		runId,
		version: 0,
		round: 0,
		nodes: [],
		edges: [],
		assets: [],
		assetEdges: [],
		todo: "",
	};
	const root = node(graph, "origin", "fact", "Human task and constraints", "origin", "host", now);
	const target = node(graph, "goal", "goal", goal, "open", "host", now);
	graph.nodes.push(root, target);
	graph.edges.push({ source: root.id, target: target.id, relation: "spawns" });
	return graph;
}

const taskStates: Record<PlanningTaskStatus, ArtexState> = {
	proposed: "open",
	ready: "open",
	leased: "running",
	running: "running",
	done: "done",
	disproved: "exhausted",
	blocked: "blocked",
	failed: "blocked",
	pruned: "stopped",
};

export function projectArtexGraph(graph: ArtexGraph, snapshot: PlanningSnapshot): ArtexGraph {
	const next = structuredClone(graph);
	for (const card of snapshot.evidenceCards ?? []) {
		const producer = next.nodes.find((item) => item.kind === "intent" && item.sourceTaskId === card.sourceTaskId);
		if (!producer) continue;
		const kind = ["checkpoint", "task delivery", "intent delivery"].includes(card.scope) ? "finding" : "fact";
		const id = artexId(next.runId, kind, `card:${card.id}`);
		if (next.nodes.some((item) => item.id === id)) continue;
		const item = node(
			next,
			`card:${card.id}`,
			kind,
			JSON.stringify({
				summary: card.summary,
				keyValues: card.keyValues,
				scope: card.scope,
				limitations: card.limitations,
			}),
			"confirmed",
			"worker",
			Math.max(
				0,
				...snapshot.evidence
					.filter((record) => card.evidenceRefs.includes(record.evidenceId))
					.map((record) => record.createdAt),
			),
		);
		item.confidence = card.basis ?? "inferred";
		item.evidenceRefs = card.evidenceRefs;
		item.sourceTaskId = card.sourceTaskId;
		item.sourceLeaseId = card.sourceLeaseId;
		next.nodes.push(item);
		next.edges.push({ source: producer.id, target: item.id, relation: "yields" });
	}
	for (const item of next.nodes) {
		if (item.kind !== "intent") continue;
		const task = snapshot.tasks.find((candidate) => candidate.taskId === item.sourceTaskId);
		if (!task) continue;
		item.state = taskStates[task.status];
		if (
			["cancelled", "failed", "completed"].includes(snapshot.run.status) &&
			["open", "running"].includes(item.state)
		)
			item.state = "stopped";
		else if (snapshot.run.status === "paused" && ["open", "running"].includes(item.state)) item.state = "paused";
		item.owner = snapshot.activeLeases?.find((lease) => lease.taskId === task.taskId)?.leaseId;
		item.blockedReason = task.lastError;
		if (["open", "running", "paused"].includes(item.state)) item.lastActiveRound = next.round;
	}
	const proof = trustedPlanningVerificationFromSnapshot(snapshot);
	if (proof) {
		const proofId = artexId(next.runId, "finding", proof.evidenceId);
		if (!next.nodes.some((item) => item.id === proofId)) {
			const finding = node(
				next,
				proof.evidenceId,
				"finding",
				"Native verifier accepted the goal",
				"confirmed",
				"host",
				proof.evidenceCreatedAt,
			);
			finding.sourceTaskId = proof.taskId;
			finding.sourceLeaseId = proof.leaseId;
			finding.evidenceRefs = [proof.evidenceId];
			next.nodes.push(finding);
			next.edges.push({
				source: artexId(next.runId, "intent", proof.taskId),
				target: finding.id,
				relation: "yields",
			});
		}
		for (const goal of next.nodes.filter((item) => item.kind === "goal")) {
			goal.state = "met";
			if (
				!next.edges.some((edge) => edge.source === proofId && edge.target === goal.id && edge.relation === "proves")
			)
				next.edges.push({ source: proofId, target: goal.id, relation: "proves" });
		}
	}
	return next;
}

function assertRefs(ids: string[], known: Set<string>, label: string, fieldPaths?: string[]): void {
	if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !known.has(id))) {
		if (fieldPaths) throw new ArtexInputError("artex_unknown_reference", `Unknown ${label} reference`, fieldPaths);
		throw new Error(`Unknown ${label} reference`);
	}
}

export function validateArtexGraph(graph: ArtexGraph): void {
	const nodes = new Map(graph.nodes.map((item) => [item.id, item]));
	const assets = new Set(graph.assets.map((item) => item.id));
	if (nodes.size !== graph.nodes.length || assets.size !== graph.assets.length) throw new Error("Duplicate graph ID");
	for (const item of graph.nodes) assertRefs(item.anchors, assets, "asset");
	const adjacency = new Map<string, string[]>();
	for (const edge of graph.edges) {
		if (!nodes.has(edge.source) || !nodes.has(edge.target)) throw new Error("Dangling graph edge");
		if (edge.relation === "covers") {
			if (nodes.get(edge.source)?.kind !== "digest") throw new Error("Only a digest may cover nodes");
			continue;
		}
		if (edge.relation === "proves") {
			if (nodes.get(edge.target)?.kind !== "goal" || nodes.get(edge.source)?.origin !== "host")
				throw new Error("Only a host proof may satisfy a goal");
			continue;
		}
		const targets = adjacency.get(edge.source) ?? [];
		targets.push(edge.target);
		adjacency.set(edge.source, targets);
	}
	const indegrees = new Map([...nodes.keys()].map((id) => [id, 0]));
	for (const targets of adjacency.values())
		for (const target of targets) indegrees.set(target, (indegrees.get(target) ?? 0) + 1);
	const frontier = [...indegrees].filter(([, count]) => count === 0).map(([id]) => id);
	for (let index = 0; index < frontier.length; index++) {
		for (const target of adjacency.get(frontier[index]) ?? []) {
			const count = (indegrees.get(target) ?? 0) - 1;
			indegrees.set(target, count);
			if (!count) frontier.push(target);
		}
	}
	if (frontier.length !== nodes.size) throw new Error("Causal graph contains a cycle");
	for (const edge of graph.assetEdges) assertRefs([edge.source, edge.target], assets, "asset edge");
}

export function foldArtexGraph(graph: ArtexGraph): ArtexGraph {
	const next = structuredClone(graph);
	const live = new Set(
		next.nodes
			.filter((item) => item.kind === "intent" && ["open", "running", "paused"].includes(item.state))
			.map((item) => item.id),
	);
	const hot = new Set(live);
	const causal = next.edges.filter((edge) => edge.relation !== "covers");
	const ancestors = new Map<string, string[]>();
	for (const edge of causal) {
		ancestors.set(edge.target, [...(ancestors.get(edge.target) ?? []), edge.source]);
		if (live.has(edge.source)) hot.add(edge.target);
	}
	const queue = [...hot];
	for (let index = 0; index < queue.length; index++)
		for (const parent of ancestors.get(queue[index]) ?? [])
			if (!hot.has(parent)) {
				hot.add(parent);
				queue.push(parent);
			}
	const covered = new Set(next.edges.filter((edge) => edge.relation === "covers").map((edge) => edge.target));
	const eligible = new Set(
		next.nodes
			.filter(
				(item) =>
					!hot.has(item.id) &&
					!covered.has(item.id) &&
					((item.kind === "intent" && ["done", "blocked", "exhausted", "stopped"].includes(item.state)) ||
						(item.kind === "fact" && item.state !== "origin")) &&
					next.round - item.lastActiveRound >= ARTEX_COLD_ROUNDS,
			)
			.map((item) => item.id),
	);
	const neighbors = new Map<string, string[]>();
	for (const edge of causal) {
		if (!eligible.has(edge.source) || !eligible.has(edge.target)) continue;
		neighbors.set(edge.source, [...(neighbors.get(edge.source) ?? []), edge.target]);
		neighbors.set(edge.target, [...(neighbors.get(edge.target) ?? []), edge.source]);
	}
	while (eligible.size) {
		const component = [eligible.values().next().value as string];
		eligible.delete(component[0]);
		for (let index = 0; index < component.length; index++)
			for (const adjacent of neighbors.get(component[index]) ?? [])
				if (eligible.delete(adjacent)) component.push(adjacent);
		if (component.length < ARTEX_MIN_FOLD_SIZE) continue;
		const members = next.nodes.filter((item) => component.includes(item.id));
		const digest = node(
			next,
			component.sort().join("\0"),
			"digest",
			members
				.map((item) => `${item.id}: ${item.payload.slice(0, 160)}`)
				.join("\n")
				.slice(0, 2000),
			"confirmed",
			"host",
			Math.max(...members.map((item) => item.createdAt)),
		);
		digest.evidenceRefs = [...new Set(members.flatMap((item) => item.evidenceRefs))];
		next.nodes.push(digest);
		for (const member of members) next.edges.push({ source: digest.id, target: member.id, relation: "covers" });
	}
	return next;
}

export function artexGraphView(graph: ArtexGraph) {
	const live = new Set(
		graph.nodes
			.filter((item) => item.kind === "intent" && ["open", "running", "paused"].includes(item.state))
			.map((item) => item.id),
	);
	const hot = new Set(live);
	for (const edge of graph.edges) if (edge.relation !== "covers" && live.has(edge.source)) hot.add(edge.target);
	const queue = [...hot];
	for (let index = 0; index < queue.length; index++)
		for (const edge of graph.edges)
			if (edge.relation !== "covers" && edge.target === queue[index] && !hot.has(edge.source)) {
				hot.add(edge.source);
				queue.push(edge.source);
			}
	const folded = new Map(
		graph.edges
			.filter((edge) => edge.relation === "covers" && !hot.has(edge.target))
			.map((edge) => [edge.target, edge.source]),
	);
	const nodes = graph.nodes.filter((item) => !folded.has(item.id));
	const edges = graph.edges
		.filter((edge) => edge.relation !== "covers")
		.map((edge) => ({
			...edge,
			source: folded.get(edge.source) ?? edge.source,
			target: folded.get(edge.target) ?? edge.target,
		}))
		.filter((edge) => edge.source !== edge.target);
	return {
		...graph,
		nodes,
		edges: [...new Map(edges.map((edge) => [JSON.stringify(edge), edge])).values()],
		foldedNodeCount: folded.size,
		digests: graph.nodes
			.filter((item) => item.kind === "digest")
			.map((item) => ({
				id: item.id,
				memberIds: graph.edges
					.filter((edge) => edge.relation === "covers" && edge.source === item.id)
					.map((edge) => edge.target),
			})),
	};
}

export function applyArtexPlan(
	graph: ArtexGraph,
	update: ArtexPlanUpdate,
	snapshot: PlanningSnapshot,
	tasks: CompiledPlanningTask[],
): ArtexGraph {
	if (graph.runId !== snapshot.run.runId || graph.round !== update.expectedRound)
		throw new Error("Stale Artex planning round");
	if (update.todo.length > 8000)
		throw new ArtexInputError("artex_proposal_invalid", "Artex TODO exceeds 8000 characters", ["todo"]);
	const next = projectArtexGraph(graph, snapshot);
	next.round++;
	next.version++;
	next.todo = update.todo;
	const known = new Set(next.nodes.map((item) => item.id));
	const evidence = new Set(snapshot.evidence.map((item) => item.evidenceId));
	for (const hint of update.hints) {
		assertRefs(hint.parentIds, known, "hint parent", ["hints.parentIds"]);
		assertRefs(hint.evidenceRefs, evidence, "evidence", ["hints.evidenceRefs"]);
		const item = node(next, hint.key, "hint", hint.payload, "open", "planner", Date.now());
		if (known.has(item.id))
			throw new ArtexInputError("artex_duplicate_reference", "Duplicate hint; reuse the existing node", [
				"hints.key",
			]);
		item.evidenceRefs = hint.evidenceRefs;
		next.nodes.push(item);
		known.add(item.id);
		for (const parent of hint.parentIds)
			next.edges.push({ source: parent, target: item.id, relation: "derived_from" });
	}
	if (
		update.intents.length !== tasks.length ||
		new Set(update.intents.map((item) => item.taskId)).size !== tasks.length
	)
		throw new ArtexInputError("artex_proposal_invalid", "Every new task must have one intent", ["tasks"]);
	const taskIds = new Set(tasks.map((task) => task.taskId));
	if (update.intents.some((binding) => !taskIds.has(binding.taskId)))
		throw new ArtexInputError("artex_unknown_reference", "Unknown intent task", ["tasks"]);
	for (const task of tasks) {
		const id = artexId(next.runId, "intent", task.taskId);
		if (known.has(id))
			throw new ArtexInputError("artex_duplicate_reference", "Duplicate intent; preserve its current owner", [
				"tasks.key",
			]);
		known.add(id);
	}
	for (const task of tasks) {
		const binding = update.intents.find((item) => item.taskId === task.taskId);
		if (!binding?.parentIds.length)
			throw new ArtexInputError("artex_proposal_invalid", "Intent requires a causal parent", ["tasks.parentIds"]);
		assertRefs(binding.parentIds, known, "intent parent", ["tasks.parentIds"]);
		assertRefs(binding.anchors, new Set(next.assets.map((item) => item.id)), "asset", ["tasks.anchors"]);
		const item = node(next, task.taskId, "intent", task.objective, "open", "planner", Date.now());
		item.sourceTaskId = task.taskId;
		item.priority = task.priority;
		item.anchors = binding.anchors;
		item.evidenceRefs = task.inputEvidenceRefs ?? [];
		next.nodes.push(item);
		for (const parent of binding.parentIds)
			next.edges.push({
				source: parent,
				target: item.id,
				relation:
					next.nodes.find((candidate) => candidate.id === parent)?.kind === "goal" ? "spawns" : "derived_from",
			});
	}
	validateArtexGraph(next);
	return foldArtexGraph(next);
}

export function artexObservationHash(input: ArtexObservation): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				kind: input.kind,
				payload: input.payload,
				confidence: input.confidence,
				evidenceRefs: [...new Set(input.evidenceRefs)].sort(),
				parentIds: [...new Set(input.parentIds ?? [])].sort(),
				anchors: [...new Set(input.anchors ?? [])].sort(),
				assets: (input.assets ?? []).map((asset) => [asset.key, asset.type, asset.label]).sort(),
				assetEdges: (input.assetEdges ?? []).map((edge) => [edge.source, edge.target, edge.relation]).sort(),
			}),
		)
		.digest("hex");
}

export function applyArtexObservation(
	graph: ArtexGraph,
	input: ArtexObservation,
	snapshot: PlanningSnapshot,
	taskId: string,
	leaseId: string,
): ArtexGraph {
	if (!input.key.trim())
		throw new ArtexInputError("artex_observation_invalid", "Invalid bounded Artex observation", ["key"]);
	if (!input.payload.trim())
		throw new ArtexInputError("artex_observation_invalid", "Invalid bounded Artex observation", ["payload"]);
	if (JSON.stringify(input).length > 20000)
		throw new ArtexInputError("artex_observation_invalid", "Invalid bounded Artex observation", ["root"]);
	if (!["fact", "finding"].includes(input.kind) || !["observed", "inferred"].includes(input.confidence))
		throw new ArtexInputError("artex_observation_invalid", "Invalid observation kind or confidence", [
			"kind",
			"confidence",
		]);
	const evidence = new Set(
		snapshot.evidence
			.filter((item) => item.runId === graph.runId && item.kind === "tool" && item.metadata.isError !== true)
			.map((item) => item.evidenceId),
	);
	if (!input.evidenceRefs.length)
		throw new ArtexInputError("artex_evidence_required", "Observation requires persisted evidence", ["evidenceRefs"]);
	assertRefs(input.evidenceRefs, evidence, "evidence", ["evidenceRefs"]);
	const next = structuredClone(graph);
	const origin = next.nodes.find((item) => item.kind === "intent" && item.sourceTaskId === taskId);
	if (!origin || snapshot.run.runId !== next.runId) throw new Error("Observation has no scoped intent");
	const item = node(next, `${taskId}:${input.key}`, input.kind, input.payload, "confirmed", "worker", Date.now());
	item.confidence = input.confidence;
	item.evidenceRefs = [...new Set(input.evidenceRefs)];
	item.sourceTaskId = taskId;
	item.sourceLeaseId = leaseId;
	item.observationHash = artexObservationHash(input);
	const existing = next.nodes.find((candidate) => candidate.id === item.id);
	if (existing) {
		if (existing.observationHash === item.observationHash) return next;
		throw new ArtexInputError(
			"artex_observation_key_conflict",
			"Observation key already exists; preserve it and publish a new version",
			["key"],
		);
	}
	const assets = new Map(next.assets.map((asset) => [asset.id, asset.id]));
	for (const asset of input.assets ?? []) {
		const id = artexId(next.runId, "asset", asset.key);
		assets.set(asset.key, id);
		const prior = next.assets.find((entry) => entry.id === id);
		if (prior && (prior.type !== asset.type || prior.label !== asset.label))
			throw new ArtexInputError("artex_asset_conflict", "Asset identity conflict", ["assets"]);
		if (!prior)
			next.assets.push({
				id,
				type: asset.type,
				label: asset.label,
				evidenceRefs: item.evidenceRefs,
				sourceTaskId: taskId,
			});
		else prior.evidenceRefs = [...new Set([...prior.evidenceRefs, ...item.evidenceRefs])];
	}
	item.anchors = (input.anchors ?? []).map((id) => assets.get(id) ?? id);
	assertRefs(item.anchors, new Set(next.assets.map((asset) => asset.id)), "asset", ["anchors"]);
	const parents = [...new Set([origin.id, ...(input.parentIds ?? [])])];
	assertRefs(parents, new Set(next.nodes.map((entry) => entry.id)), "observation parent", ["parentIds"]);
	next.nodes.push(item);
	for (const parent of parents)
		next.edges.push({ source: parent, target: item.id, relation: parent === origin.id ? "yields" : "derived_from" });
	for (const edge of input.assetEdges ?? []) {
		const relation = {
			source: assets.get(edge.source) ?? edge.source,
			target: assets.get(edge.target) ?? edge.target,
			relation: edge.relation,
			evidenceRefs: item.evidenceRefs,
		};
		assertRefs([relation.source, relation.target], new Set(next.assets.map((asset) => asset.id)), "asset edge", [
			"assetEdges",
		]);
		if (!next.assetEdges.some((existing) => JSON.stringify(existing) === JSON.stringify(relation)))
			next.assetEdges.push(relation);
	}
	next.version++;
	validateArtexGraph(next);
	return next;
}
