import { randomUUID } from "node:crypto";
import { PLANNING_SCHEMA_VERSION, type PlanningExecutionReport, type PlanningSnapshot } from "./contracts.ts";
import { type PlanningExecutor, type PlanningSupervisor, runPlanningHarness } from "./harness.ts";
import { PlanningStore } from "./store.ts";

export interface PlanningSelfTestReport {
	ok: boolean;
	runId: string;
	status: PlanningSnapshot["run"]["status"];
	revision: number;
	frameRevision: number;
	taskCount: number;
	evidenceCount: number;
	executedObjectives: string[];
	supervisorCalls: number;
}

export async function runPlanningSelfTest(): Promise<PlanningSelfTestReport> {
	const store = await PlanningStore.open(":memory:");
	const runId = randomUUID();
	const executedObjectives: string[] = [];
	let supervisorCalls = 0;
	const supervisor: PlanningSupervisor = {
		async propose({ snapshot }) {
			supervisorCalls += 1;
			if (snapshot.tasks.length === 0)
				return {
					schemaVersion: PLANNING_SCHEMA_VERSION,
					expectedRevision: snapshot.run.revision,
					decision: "create_tasks",
					rationale: "Inspect before choosing the next step",
					tasks: [
						{
							key: "inspect",
							objective: "Inspect the target",
							doneWhen: "inspection evidence exists",
							priority: 10,
						},
					],
					answerEvidenceRefs: [],
				};
			if (snapshot.tasks.length === 1)
				return {
					schemaVersion: PLANNING_SCHEMA_VERSION,
					expectedRevision: snapshot.run.revision,
					decision: "create_tasks",
					rationale: "Use the inspection result to verify the finding",
					tasks: [
						{
							key: "verify",
							objective: "Verify the finding",
							doneWhen: "verification evidence exists",
							dependsOn: [snapshot.tasks[0].taskId],
						},
					],
					answerEvidenceRefs: [],
				};
			const evidenceId = [...snapshot.evidence].reverse().find((item) => item.kind === "tool")?.evidenceId;
			return {
				schemaVersion: PLANNING_SCHEMA_VERSION,
				expectedRevision: snapshot.run.revision,
				decision: "finish_run",
				rationale: "Both bounded tasks produced persisted evidence",
				tasks: [],
				answerEvidenceRefs: evidenceId ? [evidenceId] : [],
			};
		},
	};
	const executor: PlanningExecutor = {
		async execute({ lease }): Promise<PlanningExecutionReport> {
			executedObjectives.push(lease.objective);
			const serialized = JSON.stringify({ objective: lease.objective, verified: true });
			const evidenceId = `self-test-${executedObjectives.length}`;
			return {
				result: {
					schemaVersion: PLANNING_SCHEMA_VERSION,
					leaseId: lease.leaseId,
					outcome: "done",
					summary: `${lease.objective} completed`,
					suggestedTasks: [],
					flagCandidates: [],
					evidenceRefs: [evidenceId],
					facts: [{ key: `selfTest.step.${executedObjectives.length}`, value: true, evidenceRefs: [evidenceId] }],
					rejectedDirections: [],
					openQuestions:
						executedObjectives.length === 1 ? [{ questionId: "q-verify", text: "Is the finding verified?" }] : [],
					resolvedQuestionIds: executedObjectives.length === 2 ? ["q-verify"] : [],
					artifacts: [],
				},
				evidence: [
					{ evidenceId, kind: "tool", source: "planning-self-test", summary: serialized, contentHash: evidenceId },
				],
				commitSource: "planning_commit_result",
			};
		},
	};
	try {
		store.createRun({
			runId,
			outerTaskId: `self-test-${runId}`,
			goal: "Validate progressive planning",
			mode: "active",
		});
		const snapshot = await runPlanningHarness(runId, {
			store,
			supervisor,
			executor,
			maximumSteps: 4,
			maximumTasks: 8,
			leaseTtlMs: 30_000,
			maximumEvidenceBytes: 8_192,
			allowedScope: process.cwd(),
		});
		const ok =
			snapshot.run.status === "completed" &&
			snapshot.tasks.length === 2 &&
			snapshot.evidence.length === 4 &&
			snapshot.executionFrame.revision === 2 &&
			snapshot.executionFrame.frame.taskSummaries.length === 2 &&
			snapshot.executionFrame.frame.facts.length === 2 &&
			snapshot.executionFrame.frame.openQuestions.length === 0 &&
			supervisorCalls === 3 &&
			executedObjectives.join("|") === "Inspect the target|Verify the finding";
		return {
			ok,
			runId,
			status: snapshot.run.status,
			revision: snapshot.run.revision,
			frameRevision: snapshot.executionFrame.revision,
			taskCount: snapshot.tasks.length,
			evidenceCount: snapshot.evidence.length,
			executedObjectives,
			supervisorCalls,
		};
	} finally {
		store.close();
	}
}
