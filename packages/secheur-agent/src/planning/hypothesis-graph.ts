import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import type { PlanningSnapshot } from "./contracts.ts";
import { type EvidenceCard, createEvidenceCard } from "./evidence-cards.ts";
import { PlanningFailureError } from "./failures.ts";
import { artifactLogicalPath } from "./frame-reducer.ts";
import type {
	HypothesisGraph,
	HypothesisGraphUpdate,
	HypothesisInputRequirement,
	HypothesisObservation,
} from "./hypothesis-types.ts";

export const HYPOTHESIS_INPUT_CODES = [
	"hypothesis_version_stale",
	"hypothesis_evidence_required",
	"hypothesis_unknown_evidence",
	"hypothesis_resolution_invalid",
	"hypothesis_explanation_required",
	"hypothesis_failed_observation",
	"hypothesis_premise_refuted",
	"hypothesis_card_invalid",
	"hypothesis_proposal_invalid",
	"hypothesis_graph_constraint",
	"hypothesis_basis_invalid",
	"hypothesis_binding_invalid",
	"hypothesis_input_unavailable",
	"hypothesis_wait_invalid",
] as const;

export class HypothesisInputError extends PlanningFailureError {
	readonly fieldPaths: string[];
	constructor(code: (typeof HYPOTHESIS_INPUT_CODES)[number], message: string, fieldPaths: string[]) {
		super({ source: "planning", stage: "proposal_validation", code, message });
		this.name = "HypothesisInputError";
		this.fieldPaths = fieldPaths;
	}
}

export function resolveHypothesisArtifactInput(
	graph: HypothesisGraph,
	snapshot: PlanningSnapshot,
	input: HypothesisInputRequirement,
): { kind: "resolved"; artifactPath: string } | { kind: "missing" | "ambiguous" } {
	if (
		!input.artifactPath ||
		!snapshot.tasks.some((task) => task.taskId === input.sourceTaskId && task.runId === snapshot.run.runId)
	)
		return { kind: "missing" };
	const absolute = posix.isAbsolute(input.artifactPath) || win32.isAbsolute(input.artifactPath);
	const logicalPath = absolute ? undefined : artifactLogicalPath(input.artifactPath);
	if (!absolute && !logicalPath) return { kind: "missing" };
	const activeProducer = (snapshot.activeLeases ?? (snapshot.activeLease ? [snapshot.activeLease] : [])).find(
		(lease) => lease.taskId === input.sourceTaskId,
	);
	const candidates = [
		...(graph.checkpointArtifacts ?? []),
		...snapshot.executionFrame.frame.artifacts,
		...(snapshot.latestCheckpoint?.taskId === input.sourceTaskId
			? snapshot.latestCheckpoint.artifacts.map((item) => ({ ...item, sourceTaskId: input.sourceTaskId }))
			: []),
	];
	const paths = new Set(
		candidates
			.filter(
				(item) =>
					item.sourceTaskId === input.sourceTaskId &&
					(absolute
						? item.path === input.artifactPath
						: "logicalPath" in item &&
							item.logicalPath === logicalPath &&
							"sourceLeaseId" in item &&
							Boolean(item.sourceLeaseId) &&
							(!activeProducer || item.sourceLeaseId === activeProducer.leaseId)),
			)
			.map((item) => item.path),
	);
	return paths.size === 1
		? { kind: "resolved", artifactPath: [...paths][0] }
		: { kind: paths.size ? "ambiguous" : "missing" };
}

export function emptyHypothesisGraph(): HypothesisGraph {
	return { version: 0, nodes: [], cards: [], taskBindings: [] };
}
export function hypothesisId(runId: string, key: string): string {
	return `hyp_${createHash("sha256").update(`${runId}\0${key}`).digest("hex").slice(0, 24)}`;
}
export function validateHypothesisGraph(graph: HypothesisGraph): void {
	const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
	if (nodes.size !== graph.nodes.length)
		throw new HypothesisInputError("hypothesis_graph_constraint", "Duplicate hypothesis identity", ["newHypotheses"]);
	const unresolved = (id: string) => !["verified", "refuted"].includes(nodes.get(id)?.status ?? "pending");
	if (graph.nodes.filter((node) => unresolved(node.id)).length > 4)
		throw new HypothesisInputError("hypothesis_graph_constraint", "At most four unresolved hypotheses in the graph", [
			"newHypotheses",
		]);
	const visiting = new Set<string>();
	const depths = new Map<string, number>();
	const visit = (id: string): number => {
		if (visiting.has(id))
			throw new HypothesisInputError("hypothesis_graph_constraint", "Hypothesis derivation cycle", [
				"newHypotheses[].parentHypothesisIds",
			]);
		const node = nodes.get(id);
		if (!node)
			throw new HypothesisInputError("hypothesis_graph_constraint", `Unknown parent hypothesis: ${id}`, [
				"newHypotheses[].parentHypothesisIds",
			]);
		if (depths.has(id)) return depths.get(id)!;
		visiting.add(id);
		const depth = Math.max(0, ...node.parentHypothesisIds.map(visit)) + Number(unresolved(id));
		visiting.delete(id);
		if (depth > 2)
			throw new HypothesisInputError(
				"hypothesis_graph_constraint",
				"At most two unresolved hypotheses on every derivation path",
				["newHypotheses[].parentHypothesisIds"],
			);
		depths.set(id, depth);
		return depth;
	};
	for (const node of graph.nodes) visit(node.id);
}

export function applyHypothesisUpdate(
	graph: HypothesisGraph,
	update: HypothesisGraphUpdate,
	snapshot: PlanningSnapshot,
	newTaskIds: string[],
	newDependencies: { taskId: string; dependsOnTaskIds: string[] }[] = [],
): HypothesisGraph {
	if (update.expectedVersion > graph.version)
		throw new HypothesisInputError(
			"hypothesis_version_stale",
			"Stale hypothesis graph version; retain current owners and correct the proposal",
			["expectedVersion"],
		);
	const next = structuredClone(graph);
	const evidence = new Set(snapshot.evidence.map((item) => item.evidenceId));
	const knownTasks = new Set(snapshot.tasks.map((item) => item.taskId));
	const tasks = new Set([...knownTasks, ...newTaskIds]);
	for (const node of update.newNodes) {
		if (
			next.nodes.some(
				(old) => old.id === node.id || old.statement.trim().toLowerCase() === node.statement.trim().toLowerCase(),
			)
		)
			throw new HypothesisInputError("hypothesis_graph_constraint", "Duplicate hypothesis; reuse its existing ID", [
				"newHypotheses",
			]);
		if (node.status !== "pending" || node.verificationEvidenceRefs.length)
			throw new HypothesisInputError(
				"hypothesis_graph_constraint",
				"Only executor observations can resolve a hypothesis",
				["newHypotheses[].status"],
			);
		const deliveries = new Set(snapshot.executionFrame.frame.taskSummaries.map((item) => item.taskId));
		if (snapshot.latestCheckpoint) deliveries.add(snapshot.latestCheckpoint.taskId);
		if (
			!node.basisRefs.length ||
			node.basisRefs.some((ref) => ref !== "human:goal" && !evidence.has(ref) && !deliveries.has(ref))
		)
			throw new HypothesisInputError(
				"hypothesis_basis_invalid",
				"Hypothesis basis must reference same-run evidence, existing task delivery or human:goal",
				["newHypotheses[].basisRefs"],
			);
		next.nodes.push(node);
	}
	// Revalidate append-only proposals on the latest state. Unrelated checkpoints
	// need not force another model call; no existing node or owner is overwritten.
	for (const node of update.newNodes)
		if (
			node.parentHypothesisIds.some((id) =>
				next.nodes.some((parent) => parent.id === id && (parent.status === "refuted" || parent.needsReview)),
			)
		)
			throw new HypothesisInputError(
				"hypothesis_premise_refuted",
				"Refuted or review-required premise cannot support a new hypothesis",
				["newHypotheses[].parentHypothesisIds"],
			);
	validateHypothesisGraph(next);
	for (const binding of update.newBindings) {
		if (!newTaskIds.includes(binding.taskId) || next.taskBindings.some((old) => old.taskId === binding.taskId))
			throw new HypothesisInputError("hypothesis_binding_invalid", "Binding must belong to a new task", ["tasks"]);
		if (binding.purpose === "test_hypothesis" && !binding.hypothesisIds.length)
			throw new HypothesisInputError("hypothesis_binding_invalid", "Hypothesis test requires a hypothesis ID", [
				"tasks[].hypothesisIds",
			]);
		if (
			binding.hypothesisIds.some(
				(id) =>
					!next.nodes.some(
						(node) =>
							node.id === id &&
							(binding.purpose === "review_basis" || (node.status !== "refuted" && !node.needsReview)),
					),
			)
		)
			throw new HypothesisInputError(
				"hypothesis_binding_invalid",
				"Unknown, refuted or review-required hypothesis binding; use an explicit review_basis task",
				["tasks[].hypothesisIds", "tasks[].purpose"],
			);
		if (!binding.hypothesisIds.length && binding.purpose !== "gather_evidence" && binding.purpose !== "verify_goal")
			throw new HypothesisInputError(
				"hypothesis_binding_invalid",
				"Unbound task must gather a concrete missing observation or verify the final goal",
				["tasks[].purpose"],
			);
		for (const requirement of binding.requiredInputs) {
			if (
				!tasks.has(requirement.sourceTaskId) ||
				requirement.sourceTaskId === binding.taskId ||
				Boolean(requirement.evidenceId) === Boolean(requirement.artifactPath)
			)
				throw new HypothesisInputError(
					"hypothesis_binding_invalid",
					"Input requires another same-run task and exactly one evidenceId or artifactPath",
					["tasks[].requiredInputs"],
				);
			const producer = snapshot.tasks.find((task) => task.taskId === requirement.sourceTaskId);
			if (
				producer &&
				["done", "disproved", "blocked", "failed", "pruned"].includes(producer.status) &&
				requirement.artifactPath &&
				resolveHypothesisArtifactInput(next, snapshot, requirement).kind !== "resolved"
			)
				throw new HypothesisInputError(
					"hypothesis_input_unavailable",
					"Input producer has ended without the required artifact; gather the missing observation independently",
					["tasks[].requiredInputs[].artifactPath"],
				);
			if (
				requirement.evidenceId &&
				!snapshot.evidence.some(
					(item) => item.evidenceId === requirement.evidenceId && item.taskId === requirement.sourceTaskId,
				)
			)
				throw new HypothesisInputError(
					"hypothesis_input_unavailable",
					"Unknown input evidence or wrong source task",
					["tasks[].requiredInputs[].evidenceId", "tasks[].requiredInputs[].sourceTaskId"],
				);
		}
		next.taskBindings.push(binding);
	}
	if (newTaskIds.some((id) => !next.taskBindings.some((binding) => binding.taskId === id)))
		throw new HypothesisInputError("hypothesis_binding_invalid", "Every DAG task requires a binding", ["tasks"]);
	// Artifact requirements are execution edges too; check cycles independently of derivation edges.
	const taskEdges = new Map(
		next.taskBindings.map((binding) => [binding.taskId, binding.requiredInputs.map((item) => item.sourceTaskId)]),
	);
	for (const task of snapshot.tasks)
		taskEdges.set(task.taskId, [...(taskEdges.get(task.taskId) ?? []), ...task.dependsOnTaskIds]);
	for (const task of newDependencies)
		taskEdges.set(task.taskId, [...(taskEdges.get(task.taskId) ?? []), ...task.dependsOnTaskIds]);
	const active = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (active.has(id))
			throw new HypothesisInputError("hypothesis_graph_constraint", "Required-input dependency cycle", [
				"tasks[].requiredInputs",
			]);
		if (visited.has(id)) return;
		active.add(id);
		for (const parent of taskEdges.get(id) ?? []) visit(parent);
		active.delete(id);
		visited.add(id);
	};
	for (const id of taskEdges.keys()) visit(id);
	next.version++;
	return next;
}

export function applyHypothesisObservation(
	graph: HypothesisGraph,
	observation: HypothesisObservation,
	snapshot: PlanningSnapshot,
	taskId: string,
	leaseId: string,
): HypothesisGraph {
	if (graph.version !== observation.expectedVersion)
		throw new HypothesisInputError(
			"hypothesis_version_stale",
			"Stale graph version; read current overview and resubmit",
			["expectedVersion"],
		);
	const binding = graph.taskBindings.find((item) => item.taskId === taskId);
	if (!binding) throw new Error("Current task has no hypothesis binding");
	const allRefs = [...observation.card.evidenceRefs, ...observation.resolutions.flatMap((item) => item.evidenceRefs)];
	if (!observation.card.evidenceRefs.length)
		throw new HypothesisInputError(
			"hypothesis_evidence_required",
			"Evidence card requires original evidence references",
			["card.evidenceRefs"],
		);
	for (const ref of allRefs) {
		const item = snapshot.evidence.find((item) => item.evidenceId === ref && item.runId === snapshot.run.runId);
		if (!item || item.kind !== "tool")
			throw new HypothesisInputError(
				"hypothesis_unknown_evidence",
				"Card and verdict must reference original same-run tool observations. Use full evidence IDs from the board or planning_list_evidence when available.",
				["card.evidenceRefs", "resolutions[].evidenceRefs"],
			);
	}
	const next = structuredClone(graph);
	let card: EvidenceCard;
	try {
		card = createEvidenceCard({ runId: snapshot.run.runId, taskId, leaseId }, observation.card, (id) =>
			snapshot.evidence.find((item) => item.evidenceId === id),
		);
	} catch (error) {
		throw new HypothesisInputError(
			"hypothesis_card_invalid",
			error instanceof Error ? error.message : "Invalid evidence card",
			["card"],
		);
	}
	if (!next.cards.some((item) => item.id === card.id)) next.cards.push(card);
	for (const [index, resolution] of observation.resolutions.entries()) {
		const node = next.nodes.find((item) => item.id === resolution.hypothesisId);
		if (!node || !binding.hypothesisIds.includes(node.id) || !resolution.evidenceRefs.length)
			throw new HypothesisInputError(
				"hypothesis_resolution_invalid",
				"Only assigned hypotheses can be resolved with cited evidence; read hypothesis_read_board for assigned IDs",
				[`resolutions[${index}].hypothesisId`, `resolutions[${index}].evidenceRefs`],
			);
		if (!resolution.explanation.trim())
			throw new HypothesisInputError(
				"hypothesis_explanation_required",
				"Explain how the observation meets or fails the stated criterion",
				[`resolutions[${index}].explanation`],
			);
		if (
			resolution.verdict !== "undetermined" &&
			resolution.evidenceRefs.some((id) => {
				const item = snapshot.evidence.find((item) => item.evidenceId === id)!;
				return item.metadata.isError === true;
			})
		)
			throw new HypothesisInputError(
				"hypothesis_failed_observation",
				"Tool execution failure is not a verified or refuted hypothesis",
				[`resolutions[${index}].verdict`],
			);
		const reviewed =
			binding.purpose === "review_basis" &&
			node.verificationEvidenceRefs.every((id) => resolution.reviewOfEvidenceRefs?.includes(id));
		if (["verified", "refuted"].includes(node.status) && node.status !== resolution.verdict && !reviewed) {
			node.needsReview = true; // Contradictory claims remain explicit; do not overwrite a prior verdict.
			continue;
		}
		if (
			resolution.verdict === "verified" &&
			node.parentHypothesisIds.some((id) =>
				next.nodes.some((parent) => parent.id === id && (parent.status === "refuted" || parent.needsReview)),
			)
		)
			throw new HypothesisInputError(
				"hypothesis_premise_refuted",
				"The stated premise was refuted; review the basis before treating this derived claim as a fact",
				[`resolutions[${index}].verdict`],
			);
		node.status = resolution.verdict;
		node.verificationEvidenceRefs = resolution.evidenceRefs;
		node.needsReview = false;
	}
	// Retain all original observations and descendants. Mark them for review rather than declaring them false.
	for (;;) {
		let changed = false;
		for (const node of next.nodes)
			if (
				!node.needsReview &&
				node.parentHypothesisIds.some((id) =>
					next.nodes.some((parent) => parent.id === id && (parent.status === "refuted" || parent.needsReview)),
				)
			) {
				node.needsReview = true;
				changed = true;
			}
		if (!changed) break;
	}
	validateHypothesisGraph(next);
	next.version++;
	return next;
}

export function hypothesisTaskRunnable(graph: HypothesisGraph, snapshot: PlanningSnapshot, taskId: string): boolean {
	const binding = graph.taskBindings.find((item) => item.taskId === taskId);
	if (!binding) return true;
	if (
		binding.purpose !== "review_basis" &&
		binding.hypothesisIds.some((id) =>
			graph.nodes.some((node) => node.id === id && (node.status === "refuted" || node.needsReview)),
		)
	)
		return false;
	return binding.requiredInputs.every((input) =>
		input.evidenceId
			? snapshot.evidence.some((item) => item.evidenceId === input.evidenceId && item.taskId === input.sourceTaskId)
			: resolveHypothesisArtifactInput(graph, snapshot, input).kind === "resolved",
	);
}
