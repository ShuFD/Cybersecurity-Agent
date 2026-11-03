import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const MAX_OUTPUT = 32_000;
const MAX_SNAPSHOTS = 12;
const MAX_AUDIT_EVENTS = 200;

const phases = ["detect", "respond", "recover"] as const;
const statuses = ["todo", "running", "completed", "blocked", "not_applicable"] as const;
const risks = ["low", "medium", "high", "critical"] as const;
const actionStatuses = ["proposed", "approved", "executed", "rejected", "blocked"] as const;

type Phase = (typeof phases)[number];
type TaskStatus = (typeof statuses)[number];
type RiskLevel = (typeof risks)[number];
type ActionStatus = (typeof actionStatuses)[number];

export interface SecurityTask {
	taskId: string;
	parentId?: string;
	objective: string;
	status: TaskStatus;
	priority: number;
	requiredEvidence: string[];
	evidenceRefs: string[];
	dependencies: string[];
	riskLevel: RiskLevel;
	assignedRole: "planner" | "generator" | "analyst" | "reflector" | "human";
	createdFrom: string;
	notes: string[];
}

export interface EvidenceRecord {
	evidenceId: string;
	observationId?: string;
	taskId: string;
	kind: "fact" | "indicator" | "negative" | "artifact";
	summary: string;
	source: string;
	confidence: number;
	status: "valid" | "invalidated";
	createdAt: string;
}

interface Observation {
	observationId: string;
	actionId?: string;
	taskId: string;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	createdAt: string;
}

interface ActionProposal {
	actionId: string;
	taskId: string;
	purpose: string;
	program: string;
	args: string[];
	riskLevel: RiskLevel;
	reversible: boolean;
	status: ActionStatus;
	createdAt: string;
	approvedAt?: string;
	executedAt?: string;
}

interface AuditEvent {
	eventId: string;
	type: string;
	at: string;
	detail: string;
}

interface State {
	schemaVersion: 1;
	incidentId: string;
	title: string;
	target: string;
	phase: Phase;
	paused: boolean;
	killSwitch: boolean;
	version: number;
	rootTaskId: string;
	tasks: Record<string, SecurityTask>;
	actions: Record<string, ActionProposal>;
	observations: Record<string, Observation>;
	evidence: Record<string, EvidenceRecord>;
	snapshots: State[];
	audit: AuditEvent[];
}

const toolSchema = Type.Object({
	action: StringEnum([
		"init",
		"status",
		"add_task",
		"plan",
		"propose_action",
		"approve_action",
		"execute_action",
		"record_observation",
		"analyze",
		"reflect",
		"rollback",
		"set_controls",
		"export",
	] as const),
	incidentId: Type.Optional(Type.String()),
	title: Type.Optional(Type.String()),
	target: Type.Optional(Type.String()),
	phase: Type.Optional(StringEnum(phases)),
	taskId: Type.Optional(Type.String()),
	parentId: Type.Optional(Type.String()),
	objective: Type.Optional(Type.String()),
	priority: Type.Optional(Type.Number()),
	riskLevel: Type.Optional(StringEnum(risks)),
	requiredEvidence: Type.Optional(Type.Array(Type.String())),
	dependencies: Type.Optional(Type.Array(Type.String())),
	assignedRole: Type.Optional(StringEnum(["planner", "generator", "analyst", "reflector", "human"] as const)),
	actionId: Type.Optional(Type.String()),
	purpose: Type.Optional(Type.String()),
	program: Type.Optional(Type.String()),
	args: Type.Optional(Type.Array(Type.String())),
	reversible: Type.Optional(Type.Boolean()),
	observationId: Type.Optional(Type.String()),
	stdout: Type.Optional(Type.String()),
	stderr: Type.Optional(Type.String()),
	exitCode: Type.Optional(Type.Number()),
	timedOut: Type.Optional(Type.Boolean()),
	kind: Type.Optional(StringEnum(["fact", "indicator", "negative", "artifact"] as const)),
	summary: Type.Optional(Type.String()),
	source: Type.Optional(Type.String()),
	confidence: Type.Optional(Type.Number()),
	taskStatus: Type.Optional(StringEnum(statuses)),
	findings: Type.Optional(Type.Array(Type.String())),
	snapshotVersion: Type.Optional(Type.Number()),
	paused: Type.Optional(Type.Boolean()),
	killSwitch: Type.Optional(Type.Boolean()),
});

export type IRCopilotInput = Static<typeof toolSchema>;

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const clip = (value: string | undefined, max = MAX_OUTPUT) => (value ?? "").slice(0, max);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function emptyState(input: IRCopilotInput): State {
	const incidentId = input.incidentId?.trim() || id("incident");
	const rootTaskId = id("task");
	return {
		schemaVersion: 1,
		incidentId,
		title: input.title?.trim() || "Untitled incident",
		target: input.target?.trim() || "unspecified target",
		phase: input.phase ?? "detect",
		paused: false,
		killSwitch: false,
		version: 1,
		rootTaskId,
		tasks: {
			[rootTaskId]: {
				taskId: rootTaskId,
				objective: "Establish incident scope and preserve initial evidence",
				status: "todo",
				priority: 100,
				requiredEvidence: ["affected asset", "time window", "initial indicator"],
				evidenceRefs: [],
				dependencies: [],
				riskLevel: "low",
				assignedRole: "planner",
				createdFrom: "init",
				notes: [],
			},
		},
		actions: {},
		observations: {},
		evidence: {},
		snapshots: [],
		audit: [{ eventId: id("event"), type: "init", at: now(), detail: "Incident initialized" }],
	};
}

function activeTasks(state: State) {
	return Object.values(state.tasks)
		.filter((task) => task.status === "todo" || task.status === "running")
		.sort((a, b) => b.priority - a.priority);
}

function commandAllowed(program: string) {
	const name = program.trim().toLowerCase().split(/[\\/]/).pop() ?? "";
	return new Set(
		[
			"cat",
			"find",
			"findstr",
			"git",
			"grep",
			"head",
			"hostname",
			"ip",
			"ipconfig",
			"journalctl",
			"ls",
			"netstat",
			"ps",
			"pwd",
			"sha256sum",
			"ss",
			"stat",
			"tail",
			"uname",
			"whoami",
		].map((item) => item.toLowerCase()),
	).has(name);
}

function validateState(state: State) {
	if (state.killSwitch) return "kill switch is active";
	if (state.paused) return "incident is paused";
	return undefined;
}

function textResult(text: string, state?: State, isError = false) {
	return { content: [{ type: "text" as const, text }], details: state ? { state } : {}, isError };
}

export default function ircopilot(pi: ExtensionAPI) {
	let state: State | undefined;

	const persist = (next: State, detail: string) => {
		next.version += 1;
		next.audit.push({ eventId: id("event"), type: "state_change", at: now(), detail });
		next.audit = next.audit.slice(-MAX_AUDIT_EVENTS);
		pi.appendEntry("ircopilot-state", clone(next));
		state = next;
	};

	const mutate = (detail: string, fn: (draft: State) => void) => {
		if (!state) state = emptyState({ action: "init" });
		const draft = clone(state);
		const previous = clone(state);
		previous.snapshots = [];
		draft.snapshots = [previous, ...state.snapshots].slice(0, MAX_SNAPSHOTS);
		fn(draft);
		persist(draft, detail);
		return draft;
	};

	pi.on("session_start", (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry.type === "custom" && entry.customType === "ircopilot-reset") {
				state = undefined;
				break;
			}
			if (entry.type === "custom" && entry.customType === "ircopilot-state" && entry.data) {
				state = clone(entry.data as State);
				break;
			}
		}
		if (state && ctx.hasUI) ctx.ui.setStatus("ircopilot", `${state.incidentId} v${state.version}`);
	});

	pi.registerTool({
		name: "ircopilot",
		label: "IRCopilot",
		description:
			"Evidence-first incident response assistant implementing a Security Task Tree and Planner/Generator/Analyst/Reflector workflow.",
		promptSnippet: "Manage an evidence-first incident response task tree with safe, human-approved actions",
		promptGuidelines: [
			"Use ircopilot to create and update incident tasks instead of keeping response state only in conversation.",
			"Use ircopilot propose_action before execute_action; never claim a command succeeded without an observation and analyst evidence.",
			"Use ircopilot reflect after an observation or assessment; use rollback when a state transition is unsupported by evidence.",
			"ircopilot only executes commands from its read-only allowlist and always requires interactive human confirmation.",
		],
		parameters: toolSchema,
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			if (signal?.aborted) return textResult("Cancelled", state, true);
			if (input.action === "init") {
				state = emptyState(input);
				persist(state, `Initialized ${state.incidentId}`);
				pi.setSessionName(`IRCopilot: ${state.title}`);
				if (ctx.hasUI) ctx.ui.setStatus("ircopilot", `${state.incidentId} v${state.version}`);
				return textResult(
					`Initialized incident ${state.incidentId} for ${state.target}. Root task: ${state.rootTaskId}`,
					state,
				);
			}
			if (!state) return textResult("No incident exists. Call ircopilot with action=init first.", undefined, true);

			if (input.action === "status" || input.action === "export") {
				const summary = {
					incidentId: state.incidentId,
					title: state.title,
					target: state.target,
					phase: state.phase,
					controls: { paused: state.paused, killSwitch: state.killSwitch },
					version: state.version,
					tasks: Object.values(state.tasks).map((task) => ({
						id: task.taskId,
						objective: task.objective,
						status: task.status,
						priority: task.priority,
						evidence: task.evidenceRefs.length,
					})),
					actions: Object.values(state.actions).map((action) => ({
						id: action.actionId,
						command: [action.program, ...action.args].join(" "),
						status: action.status,
						risk: action.riskLevel,
					})),
					evidence: Object.values(state.evidence).map((evidence) => ({
						id: evidence.evidenceId,
						taskId: evidence.taskId,
						status: evidence.status,
						summary: evidence.summary,
					})),
				};
				return textResult(JSON.stringify(input.action === "export" ? state : summary, null, 2), state);
			}

			if (input.action === "set_controls") {
				const next = mutate("Updated response controls", (draft) => {
					if (input.paused !== undefined) draft.paused = input.paused;
					if (input.killSwitch !== undefined) draft.killSwitch = input.killSwitch;
				});
				return textResult(`Controls updated: paused=${next.paused}, killSwitch=${next.killSwitch}`, next);
			}

			if (input.action === "add_task") {
				if (!input.objective?.trim()) return textResult("objective is required", state, true);
				const parentId = input.parentId || state.rootTaskId;
				if (!state.tasks[parentId]) return textResult(`Unknown parent task: ${parentId}`, state, true);
				const taskId = input.taskId?.trim() || id("task");
				const next = mutate(`Added task ${taskId}`, (draft) => {
					draft.tasks[taskId] = {
						taskId,
						parentId,
						objective: input.objective!.trim(),
						status: "todo",
						priority: input.priority ?? 50,
						requiredEvidence: input.requiredEvidence ?? [],
						evidenceRefs: [],
						dependencies: input.dependencies ?? [],
						riskLevel: input.riskLevel ?? "low",
						assignedRole: input.assignedRole ?? "planner",
						createdFrom: "planner",
						notes: [],
					};
				});
				return textResult(`Added task ${taskId}`, next);
			}

			if (input.action === "plan") {
				const next = mutate("Planner selected next task", (draft) => {
					const candidate = activeTasks(draft)[0];
					if (candidate) candidate.status = "running";
				});
				const candidate = activeTasks(next)[0];
				return textResult(
					candidate
						? JSON.stringify({ role: "Planner", taskSpec: candidate }, null, 2)
						: "No todo or running tasks remain.",
					next,
				);
			}

			if (input.action === "propose_action") {
				if (!input.taskId || !state.tasks[input.taskId])
					return textResult("A valid taskId is required", state, true);
				if (!input.program?.trim()) return textResult("program is required", state, true);
				const actionId = id("action");
				const allowed = commandAllowed(input.program);
				const next = mutate(`Generator proposed action ${actionId}`, (draft) => {
					draft.actions[actionId] = {
						actionId,
						taskId: input.taskId!,
						purpose: input.purpose?.trim() || "Investigate task evidence",
						program: input.program!.trim(),
						args: input.args ?? [],
						riskLevel: input.riskLevel ?? "low",
						reversible: input.reversible ?? true,
						status: allowed ? "proposed" : "blocked",
						createdAt: now(),
					};
				});
				return textResult(
					allowed
						? `Proposed action ${actionId}; approval is required before execution.`
						: `Blocked action ${actionId}: program is outside the read-only allowlist.`,
					next,
					!allowed,
				);
			}

			if (input.action === "approve_action") {
				const proposal = input.actionId ? state.actions[input.actionId] : undefined;
				if (!proposal) return textResult("Unknown actionId", state, true);
				if (proposal.status !== "proposed")
					return textResult(`Action is ${proposal.status}, not proposed`, state, true);
				const approved = ctx.hasUI
					? await ctx.ui.confirm("Approve IRCopilot action", `${proposal.program} ${proposal.args.join(" ")}`)
					: false;
				if (!approved) return textResult("Human approval was not granted; action remains proposed.", state, true);
				const next = mutate(`Human approved action ${proposal.actionId}`, (draft) => {
					draft.actions[proposal.actionId].status = "approved";
					draft.actions[proposal.actionId].approvedAt = now();
				});
				return textResult(`Action ${proposal.actionId} approved. Call execute_action to run it.`, next);
			}

			if (input.action === "execute_action") {
				const blocked = validateState(state);
				if (blocked) return textResult(`Execution denied: ${blocked}`, state, true);
				const proposal = input.actionId ? state.actions[input.actionId] : undefined;
				if (!proposal) return textResult("Unknown actionId", state, true);
				if (proposal.status !== "approved")
					return textResult("Action must be approved by a human before execution.", state, true);
				if (!commandAllowed(proposal.program))
					return textResult("Execution denied: command is outside the read-only allowlist.", state, true);
				const result = await pi.exec(proposal.program, proposal.args, { signal, timeout: 30_000 });
				const observationId = id("obs");
				const next = mutate(`Executed action ${proposal.actionId}`, (draft) => {
					draft.actions[proposal.actionId].status = "executed";
					draft.actions[proposal.actionId].executedAt = now();
					draft.observations[observationId] = {
						observationId,
						actionId: proposal.actionId,
						taskId: proposal.taskId,
						stdout: clip(result.stdout),
						stderr: clip(result.stderr),
						exitCode: result.code,
						timedOut: Boolean(result.killed),
						createdAt: now(),
					};
				});
				return textResult(
					JSON.stringify(
						{
							role: "Executor",
							observationId,
							stdout: clip(result.stdout),
							stderr: clip(result.stderr),
							exitCode: result.code,
							timedOut: Boolean(result.killed),
						},
						null,
						2,
					),
					next,
					result.code !== 0,
				);
			}

			if (input.action === "record_observation") {
				if (!input.taskId) return textResult("taskId is required", state, true);
				const observationId = input.observationId || id("obs");
				const next = mutate(`Recorded observation ${observationId}`, (draft) => {
					draft.observations[observationId] = {
						observationId,
						taskId: input.taskId!,
						stdout: clip(input.stdout),
						stderr: clip(input.stderr),
						exitCode: input.exitCode ?? null,
						timedOut: input.timedOut ?? false,
						createdAt: now(),
					};
				});
				return textResult(
					`Recorded observation ${observationId}; Analyst must assess it before marking the task complete.`,
					next,
				);
			}

			if (input.action === "analyze") {
				if (!input.taskId || !state.tasks[input.taskId])
					return textResult("A valid taskId is required", state, true);
				if (input.observationId && !state.observations[input.observationId])
					return textResult("Unknown observationId", state, true);
				if (!input.summary?.trim() || !input.source?.trim())
					return textResult("summary and source are required", state, true);
				const evidenceId = id("evidence");
				const confidence = Math.max(0, Math.min(1, input.confidence ?? 0.5));
				const next = mutate(`Analyst added evidence ${evidenceId}`, (draft) => {
					draft.evidence[evidenceId] = {
						evidenceId,
						observationId: input.observationId,
						taskId: input.taskId!,
						kind: input.kind ?? "fact",
						summary: input.summary!.trim(),
						source: input.source!.trim(),
						confidence,
						status: "valid",
						createdAt: now(),
					};
					draft.tasks[input.taskId!].evidenceRefs.push(evidenceId);
					if (input.findings?.length) draft.tasks[input.taskId!].notes.push(...input.findings);
					if (input.taskStatus) draft.tasks[input.taskId!].status = input.taskStatus;
				});
				return textResult(
					JSON.stringify(
						{
							role: "Analyst",
							evidenceId,
							taskAssessment: {
								taskId: input.taskId,
								status: input.taskStatus ?? state.tasks[input.taskId].status,
								summary: input.summary,
								confidence,
							},
						},
						null,
						2,
					),
					next,
				);
			}

			if (input.action === "reflect") {
				const violations: string[] = [];
				for (const task of Object.values(state.tasks)) {
					if (
						task.status === "completed" &&
						task.requiredEvidence.some(
							(required) =>
								!task.evidenceRefs.some((ref) => {
									const evidence = state?.evidence[ref];
									return (
										evidence?.status === "valid" &&
										evidence.summary.toLowerCase().includes(required.toLowerCase())
									);
								}),
						)
					) {
						violations.push(`${task.taskId} is completed without evidence for all requirements`);
					}
				}
				for (const action of Object.values(state.actions)) {
					if (
						action.status === "executed" &&
						!Object.values(state.observations).some((observation) => observation.actionId === action.actionId)
					)
						violations.push(`${action.actionId} is executed without an observation`);
				}
				const decision = violations.length ? "rollback_or_human_review" : "approve";
				const next = mutate(`Reflector decision: ${decision}`, (draft) => {
					draft.audit.push({
						eventId: id("event"),
						type: "reflector",
						at: now(),
						detail: violations.join("; ") || "No invariant violations",
					});
				});
				return textResult(
					JSON.stringify({ role: "Reflector", decision, violations, version: next.version }, null, 2),
					next,
					violations.length > 0,
				);
			}

			if (input.action === "rollback") {
				const target =
					input.snapshotVersion === undefined
						? state.snapshots[0]
						: state.snapshots.find((snapshot) => snapshot.version === input.snapshotVersion);
				if (!target) return textResult("No matching rollback snapshot exists", state, true);
				const restored = clone(target);
				const invalidated = Object.values(state.evidence).filter(
					(evidence) => !restored.evidence[evidence.evidenceId],
				);
				for (const evidence of invalidated) {
					restored.evidence[evidence.evidenceId] = { ...evidence, status: "invalidated" };
				}
				restored.snapshots = state.snapshots
					.filter((snapshot) => snapshot.version !== target.version)
					.slice(0, MAX_SNAPSHOTS);
				restored.audit.push({
					eventId: id("event"),
					type: "rollback",
					at: now(),
					detail: `Restored version ${target.version}; invalidated ${invalidated.length} later evidence record(s)`,
				});
				persist(restored, `Rolled back to version ${target.version}`);
				return textResult(
					`Rolled back to version ${target.version}; invalidated ${invalidated.length} later evidence record(s). Any later state transition must be re-evaluated.`,
					restored,
				);
			}

			return textResult(`Unsupported action: ${input.action}`, state, true);
		},
	});

	pi.registerCommand("ircopilot", {
		description: "Show the current IRCopilot incident summary",
		handler: async (_args, ctx) => {
			if (!state) {
				ctx.ui.notify("IRCopilot has no active incident. Ask the agent to initialize one.", "info");
				return;
			}
			const open = activeTasks(state).length;
			ctx.ui.notify(`${state.incidentId} - ${state.phase} - ${open} active task(s) - v${state.version}`, "info");
		},
	});

	pi.registerCommand("ircopilot-reset", {
		description: "Reset the current IRCopilot incident after confirmation",
		handler: async (_args, ctx) => {
			if (
				!ctx.hasUI ||
				!(await ctx.ui.confirm(
					"Reset IRCopilot incident",
					"This removes the active in-memory response state from this session.",
				))
			)
				return;
			state = undefined;
			pi.appendEntry("ircopilot-reset", { at: now() });
			ctx.ui.notify("IRCopilot state reset.", "info");
		},
	});
}
