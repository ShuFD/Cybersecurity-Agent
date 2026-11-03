import type { PlanningSnapshot, PlanningTask } from "./contracts.ts";

const TERMINAL_STATUSES = new Set<PlanningTask["status"]>(["done", "disproved", "blocked", "failed", "pruned"]);

export interface PlanningScheduleDecision {
	kind: "execute" | "replan" | "blocked" | "waiting";
	task?: PlanningTask;
	reason: string;
}

export function readyPlanningTasks(snapshot: PlanningSnapshot): PlanningTask[] {
	return snapshot.tasks
		.filter((task) => task.status === "ready")
		.sort(
			(left, right) =>
				right.priority - left.priority || left.sequence - right.sequence || left.taskId.localeCompare(right.taskId),
		);
}

export function schedulePlanningTask(snapshot: PlanningSnapshot, availableSlots = 0): PlanningScheduleDecision {
	const active = !!(snapshot.activeLease || snapshot.activeLeases?.length);
	if (active && availableSlots < 1) return { kind: "waiting", reason: "task leases are active" };
	const ready = readyPlanningTasks(snapshot);
	if (ready[0]) return { kind: "execute", task: ready[0], reason: "highest-priority ready task" };
	if (active) return { kind: "replan", reason: "vacant Executor slot has no ready task; append useful work" };
	if (snapshot.tasks.length === 0) return { kind: "replan", reason: "no task has been planned yet" };
	if (snapshot.tasks.every((task) => TERMINAL_STATUSES.has(task.status))) {
		return { kind: "replan", reason: "all current tasks are terminal; the supervisor must choose the next step" };
	}
	return { kind: "blocked", reason: "no task is ready; dependencies or plan state are inconsistent" };
}
