import {
	type PlanningPlanProposal,
	type PlanningTask,
	type ProposedPlanningTask,
	planningTaskSignature,
	stablePlanningTaskId,
	validatePlanningTaskIdentities,
} from "./contracts.ts";
import { planningFailure } from "./failures.ts";
import type { CompiledPlanningTask } from "./store.ts";

function assertAcyclic(tasks: CompiledPlanningTask[], existingIds: Set<string>): void {
	const byId = new Map(tasks.map((task) => [task.taskId, task]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (taskId: string): void => {
		if (existingIds.has(taskId) || visited.has(taskId)) return;
		if (visiting.has(taskId))
			throw planningFailure(
				"proposal_validation",
				"proposal_validation_error",
				`Planning dependency cycle contains ${taskId}`,
			);
		const task = byId.get(taskId);
		if (!task)
			throw planningFailure(
				"proposal_validation",
				"proposal_validation_error",
				`Planning dependency does not exist: ${taskId}`,
			);
		visiting.add(taskId);
		for (const dependency of task.dependsOnTaskIds) visit(dependency);
		visiting.delete(taskId);
		visited.add(taskId);
	};
	for (const task of tasks) visit(task.taskId);
}

export function compilePlanningProposal(
	runId: string,
	proposal: PlanningPlanProposal,
	existingTasks: PlanningTask[],
	maximumTasks: number,
): CompiledPlanningTask[] {
	validatePlanningTaskIdentities(runId, proposal, existingTasks);
	const existingSignatures = new Map(existingTasks.map((task) => [planningTaskSignature(task), task.taskId]));
	const proposalSignatures = new Map<string, string>();
	for (const task of proposal.tasks) {
		const signature = planningTaskSignature(task);
		const duplicateTaskId = existingSignatures.get(signature) ?? proposalSignatures.get(signature);
		if (duplicateTaskId) {
			throw planningFailure(
				"proposal_validation",
				"duplicate_task_signature",
				`Planning task repeats the same objective, doneWhen, and input evidence as ${duplicateTaskId}`,
			);
		}
		proposalSignatures.set(signature, stablePlanningTaskId(runId, task.key));
	}
	const remaining = Math.max(0, Math.trunc(maximumTasks) - existingTasks.length);
	if (proposal.tasks.length > remaining) {
		throw planningFailure(
			"proposal_validation",
			"proposal_validation_error",
			`Plan proposes ${proposal.tasks.length} tasks but only ${remaining} slots remain`,
		);
	}
	const keys = new Set<string>();
	const idsByKey = new Map<string, string>();
	for (const task of proposal.tasks) {
		if (keys.has(task.key)) {
			throw planningFailure(
				"proposal_validation",
				"proposal_validation_error",
				`Duplicate planning task key: ${task.key}`,
			);
		}
		keys.add(task.key);
		idsByKey.set(task.key, stablePlanningTaskId(runId, task.key));
	}
	const existingIds = new Set(existingTasks.map((task) => task.taskId));
	const existingMaxSequence = existingTasks.reduce((maximum, task) => Math.max(maximum, task.sequence), -1);
	const resolveReference = (reference: string, owner: ProposedPlanningTask): string => {
		const resolved = idsByKey.get(reference) ?? (existingIds.has(reference) ? reference : undefined);
		if (!resolved) {
			throw planningFailure(
				"proposal_validation",
				"proposal_validation_error",
				`Task ${owner.key} references unknown dependency ${reference}`,
			);
		}
		if (resolved === idsByKey.get(owner.key)) {
			throw planningFailure(
				"proposal_validation",
				"proposal_validation_error",
				`Task ${owner.key} cannot depend on itself`,
			);
		}
		return resolved;
	};
	const compiled = proposal.tasks.map((task, index): CompiledPlanningTask => {
		const taskId = idsByKey.get(task.key);
		if (!taskId) {
			throw planningFailure(
				"proposal_validation",
				"proposal_validation_error",
				`Missing compiled id for planning task ${task.key}`,
			);
		}
		const dependencies = [...new Set((task.dependsOn ?? []).map((item) => resolveReference(item, task)))];
		const parentTaskId = task.parent ? resolveReference(task.parent, task) : undefined;
		return {
			taskId,
			objective: task.objective,
			doneWhen: task.doneWhen,
			priority: task.priority ?? 0,
			sequence: existingMaxSequence + index + 1,
			dependsOnTaskIds: dependencies,
			inputEvidenceRefs: [...new Set(task.inputEvidenceRefs ?? [])],
			...(parentTaskId ? { parentTaskId } : {}),
		};
	});
	assertAcyclic(compiled, existingIds);
	return compiled;
}
