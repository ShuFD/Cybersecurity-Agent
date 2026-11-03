import { fillHostPlanningFields } from "./proposal-session.ts";

/** Novelty is explained by the model and checked against host-owned references; wording alone is not proof. */
export function normalizePlanningIncrement(
	value: unknown,
	options: { engine: "progressive" | "cairn"; priorWork: boolean; evidenceIds: string[]; revision?: number },
): unknown {
	const result = fillHostPlanningFields(value, options.revision) as Record<string, unknown>;
	const tasks = options.engine === "cairn" ? result.proposedIntents : result.tasks;
	if (!Array.isArray(tasks)) return result;
	for (const task of tasks) {
		if (!task || typeof task !== "object") continue;
		const increment = task.increment as unknown;
		if (options.priorWork && (typeof increment !== "string" || !increment.trim()))
			throw new Error(
				"Explain the substantive increment relative to saved work: a new question, observation, method or deliverable. Rewording the same goal or artifact is not new work. Preserve existing owners if no useful increment exists.",
			);
		if (typeof increment === "string" && increment.length > 2000)
			throw new Error("Keep the increment explanation within 2000 characters");
		const references = task.incrementEvidenceIds as unknown;
		if (
			references !== undefined &&
			(!Array.isArray(references) ||
				references.some((id) => typeof id !== "string" || !options.evidenceIds.includes(id)))
		)
			throw new Error("Increment evidence must cite exact original observations in this run");
		if (options.engine === "cairn") {
			// Retain the explanation in existing durable rationale without changing task identity or external contracts.
			if (typeof increment === "string")
				task.rationale = `${task.rationale}\nSubstantive increment: ${increment}${Array.isArray(references) ? `; source evidence: ${references.join(", ")}` : ""}`;
			delete task.increment;
			delete task.incrementEvidenceIds;
		} else if (Array.isArray(references)) {
			task.inputEvidenceRefs = [
				...new Set([...(Array.isArray(task.inputEvidenceRefs) ? task.inputEvidenceRefs : []), ...references]),
			];
		}
	}
	return result;
}
