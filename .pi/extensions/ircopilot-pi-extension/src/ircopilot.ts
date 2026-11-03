import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const MAX_TEXT = 32_000;
const MAX_SNAPSHOTS = 12;
const MAX_AUDIT = 400;
const phases = ["detect", "respond", "recover"] as const;
const taskStatuses = ["todo", "running", "completed", "blocked", "not_applicable"] as const;
const risks = ["low", "medium", "high", "critical"] as const;
const roles = ["planner", "generator", "analyst", "reflector", "human"] as const;
const actionTypes = ["investigate", "contain", "eradicate", "recover", "validate"] as const;
const actionStatuses = ["proposed", "approved", "in_progress", "observed", "cancelled", "blocked"] as const;
const sensitivities = ["public", "internal", "restricted", "secret"] as const;
const hypothesisStatuses = ["open", "supported", "rejected", "inconclusive"] as const;

type Phase = (typeof phases)[number];
type TaskStatus = (typeof taskStatuses)[number];
type Risk = (typeof risks)[number];
type Role = (typeof roles)[number];
type ActionType = (typeof actionTypes)[number];
type ActionStatus = (typeof actionStatuses)[number];
type Sensitivity = (typeof sensitivities)[number];
type HypothesisStatus = (typeof hypothesisStatuses)[number];

interface Scope { authorized: boolean; authority: string; assets: string[]; exclusions: string[]; rules: string[]; validUntil?: string }
export interface SecurityTask { taskId: string; parentId?: string; objective: string; objectiveKind: "objective" | "procedure"; status: TaskStatus; priority: number; requiredEvidence: string[]; evidenceRefs: string[]; dependencies: string[]; riskLevel: Risk; assignedRole: Role; createdFrom: string; notes: string[] }
interface ActionProposal { actionId: string; taskId: string; type: ActionType; purpose: string; procedure: string; expectedEvidence: string[]; externalToolHint: string; riskLevel: Risk; mutatesTarget: boolean; rollbackPlan: string; approvalRequired: boolean; status: ActionStatus; createdAt: string; approvedAt?: string; startedAt?: string; completedAt?: string }
interface Observation { observationId: string; actionId?: string; taskId: string; summary: string; source: string; externalToolReference: string; artifacts: string[]; sensitivity: Sensitivity; containsSecrets: boolean; createdAt: string }
export interface EvidenceRecord { evidenceId: string; observationId?: string; taskId: string; kind: "fact" | "indicator" | "negative" | "artifact"; summary: string; source: string; confidence: number; sensitivity: Sensitivity; satisfies: string[]; relatedEvidenceIds: string[]; status: "valid" | "invalidated"; createdAt: string }
interface Hypothesis { hypothesisId: string; statement: string; status: HypothesisStatus; confidence: number; evidenceRefs: string[]; createdAt: string; updatedAt: string }
interface TimelineEvent { timelineId: string; timestamp: string; description: string; asset: string; evidenceRefs: string[]; createdAt: string }
interface FinalReport { executiveSummary: string; scopeAndLimitations: string; timeline: string; impact: string; responseAndRecovery: string; residualRisk: string; recommendations: string; completedAt: string }
interface AuditEvent { eventId: string; type: string; at: string; detail: string }
interface LoopProtectionConfig { softMutationLimit: number; hardMutationLimit: number; repeatedErrorLimit: number }
interface LoopProtectionState { mutationCalls: number; softWarningIssued: boolean; repeatedErrorCount: number; lastErrorFingerprint?: string; pauseReason?: string }
interface IRCopilotConfig { schemaVersion: 1; loopProtection: LoopProtectionConfig }
interface State { schemaVersion: 2; incidentId: string; title: string; incidentType: string; osFamily: "unknown" | "linux" | "windows" | "mixed"; phase: Phase; scope: Scope; paused: boolean; killSwitch: boolean; loopProtection?: LoopProtectionState; version: number; rootTaskId: string; tasks: Record<string, SecurityTask>; actions: Record<string, ActionProposal>; observations: Record<string, Observation>; evidence: Record<string, EvidenceRecord>; hypotheses: Record<string, Hypothesis>; timeline: Record<string, TimelineEvent>; finalReport?: FinalReport; snapshots: State[]; audit: AuditEvent[] }

const defaultConfig: IRCopilotConfig = {
	schemaVersion: 1,
	loopProtection: { softMutationLimit: 48, hardMutationLimit: 0, repeatedErrorLimit: 8 },
};
const readOnlyActions = new Set<IRCopilotInput["action"]>(["status", "report", "export"]);

const schema = Type.Object({
	action: StringEnum(["init", "status", "set_scope", "set_phase", "set_controls", "add_task", "plan", "propose_action", "approve_action", "start_action", "record_observation", "analyze", "record_hypothesis", "update_hypothesis", "record_timeline", "reflect", "cancel_action", "finish", "report", "export", "rollback"] as const),
	incidentId: Type.Optional(Type.String()), title: Type.Optional(Type.String()), incidentType: Type.Optional(Type.String()), osFamily: Type.Optional(StringEnum(["unknown", "linux", "windows", "mixed"] as const)), phase: Type.Optional(StringEnum(phases)),
	authorized: Type.Optional(Type.Boolean()), authority: Type.Optional(Type.String()), assets: Type.Optional(Type.Array(Type.String())), target: Type.Optional(Type.String()), exclusions: Type.Optional(Type.Array(Type.String())), rules: Type.Optional(Type.Array(Type.String())), validUntil: Type.Optional(Type.String()), paused: Type.Optional(Type.Boolean()), killSwitch: Type.Optional(Type.Boolean()),
	taskId: Type.Optional(Type.String()), parentId: Type.Optional(Type.String()), objective: Type.Optional(Type.String()), objectiveKind: Type.Optional(StringEnum(["objective", "procedure"] as const)), priority: Type.Optional(Type.Number()), riskLevel: Type.Optional(StringEnum(risks)), requiredEvidence: Type.Optional(Type.Array(Type.String())), dependencies: Type.Optional(Type.Array(Type.String())), assignedRole: Type.Optional(StringEnum(roles)), taskStatus: Type.Optional(StringEnum(taskStatuses)), findings: Type.Optional(Type.Array(Type.String())),
	actionId: Type.Optional(Type.String()), actionType: Type.Optional(StringEnum(actionTypes)), purpose: Type.Optional(Type.String()), procedure: Type.Optional(Type.String()), expectedEvidence: Type.Optional(Type.Array(Type.String())), externalToolHint: Type.Optional(Type.String()), mutatesTarget: Type.Optional(Type.Boolean()), rollbackPlan: Type.Optional(Type.String()),
	observationId: Type.Optional(Type.String()), summary: Type.Optional(Type.String()), source: Type.Optional(Type.String()), externalToolReference: Type.Optional(Type.String()), artifacts: Type.Optional(Type.Array(Type.String())), sensitivity: Type.Optional(StringEnum(sensitivities)), containsSecrets: Type.Optional(Type.Boolean()), kind: Type.Optional(StringEnum(["fact", "indicator", "negative", "artifact"] as const)), confidence: Type.Optional(Type.Number()), satisfies: Type.Optional(Type.Array(Type.String())), relatedEvidenceIds: Type.Optional(Type.Array(Type.String())),
	hypothesisId: Type.Optional(Type.String()), hypothesisStatus: Type.Optional(StringEnum(hypothesisStatuses)), evidenceRefs: Type.Optional(Type.Array(Type.String())), timestamp: Type.Optional(Type.String()), asset: Type.Optional(Type.String()),
	executiveSummary: Type.Optional(Type.String()), scopeAndLimitations: Type.Optional(Type.String()), timelineSummary: Type.Optional(Type.String()), impact: Type.Optional(Type.String()), responseAndRecovery: Type.Optional(Type.String()), residualRisk: Type.Optional(Type.String()), recommendations: Type.Optional(Type.String()), snapshotVersion: Type.Optional(Type.Number()),
});
export type IRCopilotInput = Static<typeof schema>;

const now = () => new Date().toISOString();
const makeId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const clean = (values: string[] | undefined) => [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
const clip = (value: string | undefined) => (value ?? "").trim().slice(0, MAX_TEXT);
const terminalTasks = new Set<TaskStatus>(["completed", "blocked", "not_applicable"]);
const terminalActions = new Set<ActionStatus>(["observed", "cancelled", "blocked"]);

function newLoopProtectionState(): LoopProtectionState {
	return { mutationCalls: 0, softWarningIssued: false, repeatedErrorCount: 0 };
}

function ensureLoopProtectionState(state: State): LoopProtectionState {
	state.loopProtection ??= newLoopProtectionState();
	return state.loopProtection;
}

function loadConfig(cwd: string): { config: IRCopilotConfig; path: string; warning?: string } {
	const candidates = [
		resolve(cwd, ".pi", "extensions", "ircopilot.json"),
		resolve(dirname(fileURLToPath(import.meta.url)), "..", "ircopilot.json"),
	];
	const path = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
	if (!existsSync(path)) return { config: defaultConfig, path, warning: "ircopilot.json not found; using integrated defaults" };
	try {
		const source = JSON.parse(readFileSync(path, "utf8")) as Partial<IRCopilotConfig>;
		const loop = source.loopProtection;
		if (source.schemaVersion !== 1 || !loop) throw new Error("schemaVersion or loopProtection is invalid");
		const boundedInteger = (name: string, value: unknown, min: number, max: number) => {
			const number = Number(value);
			if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be ${min}-${max}`);
			return number;
		};
		return { path, config: { schemaVersion: 1, loopProtection: {
			softMutationLimit: boundedInteger("softMutationLimit", loop.softMutationLimit, 0, 10000),
			hardMutationLimit: boundedInteger("hardMutationLimit", loop.hardMutationLimit, 0, 10000),
			repeatedErrorLimit: boundedInteger("repeatedErrorLimit", loop.repeatedErrorLimit, 2, 100),
		} } };
	} catch (error) {
		return { config: defaultConfig, path, warning: `Invalid ircopilot.json; using integrated defaults: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function createState(input: IRCopilotInput): State | string {
	const assets = clean([...(input.assets ?? []), ...(input.target ? [input.target] : [])]);
	if (input.authorized !== true) return "init requires authorized=true";
	if (!input.authority?.trim() || !assets.length) return "init requires authority and at least one asset";
	const rootTaskId = makeId("task");
	return { schemaVersion: 2, incidentId: input.incidentId?.trim() || makeId("incident"), title: input.title?.trim() || "Untitled incident", incidentType: input.incidentType?.trim() || "unknown", osFamily: input.osFamily ?? "unknown", phase: input.phase ?? "detect", scope: { authorized: true, authority: input.authority.trim(), assets, exclusions: clean(input.exclusions), rules: clean(input.rules), validUntil: input.validUntil?.trim() || undefined }, paused: false, killSwitch: false, loopProtection: newLoopProtectionState(), version: 1, rootTaskId,
		tasks: { [rootTaskId]: { taskId: rootTaskId, objective: "Establish scope, preserve evidence, reconstruct the attack, contain impact, and verify recovery", objectiveKind: "objective", status: "todo", priority: 100, requiredEvidence: ["affected assets", "time window", "initial indicator"], evidenceRefs: [], dependencies: [], riskLevel: "low", assignedRole: "planner", createdFrom: "init", notes: [] } },
		actions: {}, observations: {}, evidence: {}, hypotheses: {}, timeline: {}, snapshots: [], audit: [{ eventId: makeId("event"), type: "init", at: now(), detail: "Authorized incident initialized" }] };
}

function migrate(data: unknown): State | undefined {
	if (!data || typeof data !== "object") return undefined;
	const value = data as Record<string, unknown>;
	if (value.schemaVersion === 2) { const migrated = clone(data as State); ensureLoopProtectionState(migrated); return migrated; }
	if (value.schemaVersion !== 1) return undefined;
	const old = clone(data) as Record<string, unknown> & { target?: string; tasks: Record<string, SecurityTask>; evidence: Record<string, EvidenceRecord>; rootTaskId: string };
	for (const task of Object.values(old.tasks ?? {})) task.objectiveKind = task.taskId === old.rootTaskId ? "objective" : "procedure";
	return { ...(old as unknown as State), schemaVersion: 2, incidentType: "migrated", osFamily: "unknown", scope: { authorized: false, authority: "reauthorization required", assets: old.target ? [old.target] : [], exclusions: [], rules: [] }, loopProtection: newLoopProtectionState(), actions: {}, observations: {}, hypotheses: {}, timeline: {}, evidence: old.evidence ?? {} };
}

function baseResult(text: string, state?: State, isError = false) { return { content: [{ type: "text" as const, text }], details: state ? { state } : {}, isError }; }
function activeTasks(state: State) { return Object.values(state.tasks).filter((task) => task.status === "todo" || task.status === "running").sort((a, b) => b.priority - a.priority); }
function scopeBlock(state: State) { if (!state.scope.authorized) return "scope requires renewed authorization"; if (state.scope.validUntil && Date.parse(state.scope.validUntil) <= Date.now()) return "authorization expired"; if (state.killSwitch) return "kill switch is active"; if (state.paused) return `incident is paused${state.loopProtection?.pauseReason ? `: ${state.loopProtection.pauseReason}` : ""}`; return undefined; }
function validEvidence(state: State, refs: string[]) { return refs.map((ref) => state.evidence[ref]).filter((entry): entry is EvidenceRecord => entry?.status === "valid"); }
function completionError(state: State, task: SecurityTask, refs: string[]) { if (task.dependencies.some((id) => !terminalTasks.has(state.tasks[id]?.status))) return "task dependencies are unresolved"; const met = new Set(validEvidence(state, refs).flatMap((entry) => entry.satisfies)); const missing = task.requiredEvidence.filter((item) => !met.has(item)); return missing.length ? `missing required evidence: ${missing.join(", ")}` : undefined; }
function reportMarkdown(state: State) { const lines = [`# ${state.title}`, "", `- Incident: \`${state.incidentId}\``, `- Phase: \`${state.phase}\``, `- Assets: ${state.scope.assets.join(", ")}`, ""]; const report = state.finalReport; if (report) lines.push("## Executive Summary", report.executiveSummary, "", "## Scope and Limitations", report.scopeAndLimitations, "", "## Timeline", report.timeline, "", "## Impact", report.impact, "", "## Response and Recovery", report.responseAndRecovery, "", "## Residual Risk", report.residualRisk, "", "## Recommendations", report.recommendations, ""); lines.push("## Evidence Index", ""); for (const evidence of Object.values(state.evidence)) lines.push(`- ${evidence.evidenceId} [${evidence.status}/${evidence.sensitivity}] ${evidence.summary} (${evidence.source})`); return lines.join("\n"); }

export default function ircopilot(pi: ExtensionAPI) {
	let state: State | undefined;
	let config = defaultConfig;
	let configPath = "packages/ircopilot-pi-extension/ircopilot.json";
	const persist = (next: State, detail: string) => { next.version += 1; next.audit = [...next.audit, { eventId: makeId("event"), type: "state_change", at: now(), detail }].slice(-MAX_AUDIT); pi.appendEntry("ircopilot-state-v2", clone(next)); state = next; };
	const mutate = (detail: string, fn: (draft: State) => void) => { if (!state) throw new Error("No active incident"); const previous = clone(state); previous.snapshots = []; const draft = clone(state); draft.snapshots = [previous, ...state.snapshots].slice(0, MAX_SNAPSHOTS); fn(draft); persist(draft, detail); return draft; };
	const persistLoopProtection = (detail: string) => { if (!state) return; persist(state, detail); };

	pi.on("session_start", (_event, ctx) => { const loaded = loadConfig(ctx.cwd); config = loaded.config; configPath = loaded.path; if (loaded.warning && ctx.hasUI) ctx.ui.notify(loaded.warning, "warning"); const entries = ctx.sessionManager.getEntries(); for (let index = entries.length - 1; index >= 0; index--) { const entry = entries[index]; if (entry.type === "custom" && entry.customType === "ircopilot-reset") break; if (entry.type === "custom" && (entry.customType === "ircopilot-state-v2" || entry.customType === "ircopilot-state") && entry.data) { state = migrate(entry.data); break; } } if (state && ctx.hasUI) ctx.ui.setStatus("ircopilot", `${state.incidentId} ${state.phase} v${state.version}`); });

	pi.registerTool({ name: "ircopilot", label: "IRCopilot", description: "Evidence-first incident response workflow implementing an Incident Response Tree and Planner/Generator/Analyst/Reflector loop. Existing CTF/Pi/MCP tools perform environment inspection and execution.", promptSnippet: "Manage an authorized incident through reasoning, action contracts, evidence analysis, and reflection", promptGuidelines: [
		"Use IRCopilot as the workflow and evidence ledger; use existing CTF/Pi/MCP tools for environment discovery, forensics, malware analysis, and security knowledge.",
		"Never execute target actions before propose_action and start_action. Mutating containment, eradication, and recovery require approval and rollback plans.",
		"After external tool calls, record concise observations with exact tool and artifact references, then analyze them into evidence that explicitly satisfies task requirements.",
		"Keep secrets and raw sensitive material out of summaries; reference protected artifacts and label sensitivity.",
		"Reflect after material changes and finish only after evidence, response, recovery, and residual-risk gates pass.",
	], parameters: schema,
		async execute(_id, input, signal, _update, ctx) {
			let softWarning = "";
			const countedMutation = !readOnlyActions.has(input.action) && input.action !== "init" && input.action !== "set_controls";
			const result = (text: string, resultState: State | undefined = state, isError = false) => {
				if (state && countedMutation) {
					const loop = ensureLoopProtectionState(state);
					if (isError) {
						const fingerprint = `${input.action}:${text.trim().replace(/\s+/g, " ")}`;
						loop.repeatedErrorCount = loop.lastErrorFingerprint === fingerprint ? loop.repeatedErrorCount + 1 : 1;
						loop.lastErrorFingerprint = fingerprint;
						if (loop.repeatedErrorCount >= config.loopProtection.repeatedErrorLimit) {
							loop.pauseReason = `same ${input.action} error repeated ${loop.repeatedErrorCount} times`;
							state.paused = true;
							text = `Loop protection paused the incident: ${loop.pauseReason}. Stop retrying and request human review. ${text}`;
						}
						persistLoopProtection(`Loop protection recorded ${input.action} error (${loop.repeatedErrorCount})`);
					} else if (loop.repeatedErrorCount || loop.lastErrorFingerprint) {
						loop.repeatedErrorCount = 0;
						delete loop.lastErrorFingerprint;
						persistLoopProtection("Loop protection error streak cleared");
					}
				}
				if (softWarning) text = `${text}\n\n${softWarning}`;
				return baseResult(text, resultState, isError);
			};
			if (signal?.aborted) return result("Cancelled", state, true);
			if (input.action === "init") { const created = createState(input); if (typeof created === "string") return result(created, undefined, true); state = created; persist(state, `Initialized ${state.incidentId}`); pi.setSessionName(`IRCopilot: ${state.title}`); return result(`Initialized ${state.incidentId}. Root task: ${state.rootTaskId}`, state); }
			if (!state) return result("No incident exists. Call init first.", undefined, true);
			if (countedMutation) {
				const loop = ensureLoopProtectionState(state);
				if (loop.pauseReason) return baseResult(`Loop protection is active: ${loop.pauseReason}. Use status for diagnostics or set_controls paused=false after human review.`, state, true);
				if (config.loopProtection.hardMutationLimit > 0 && loop.mutationCalls >= config.loopProtection.hardMutationLimit) {
					loop.pauseReason = `plugin mutation budget exhausted (${config.loopProtection.hardMutationLimit})`;
					state.paused = true;
					persistLoopProtection("Loop protection hard mutation budget exhausted");
					return baseResult(`Plugin mutation budget exhausted (${config.loopProtection.hardMutationLimit}); incident paused. Stop retrying and request human review.`, state, true);
				}
				loop.mutationCalls += 1;
				if (config.loopProtection.softMutationLimit > 0 && loop.mutationCalls >= config.loopProtection.softMutationLimit && !loop.softWarningIssued) {
					loop.softWarningIssued = true;
					softWarning = `Loop protection warning: ${loop.mutationCalls} workflow-changing calls reached. Review progress and remaining work; no hard stop was applied.`;
				}
			}
			if (input.action === "status" || input.action === "export") { const summary = { incidentId: state.incidentId, title: state.title, phase: state.phase, scope: state.scope, controls: { paused: state.paused, killSwitch: state.killSwitch }, loopProtection: { configPath, config: config.loopProtection, state: ensureLoopProtectionState(state) }, version: state.version, tasks: Object.values(state.tasks), actions: Object.values(state.actions), hypotheses: Object.values(state.hypotheses), evidenceCount: Object.keys(state.evidence).length, timelineCount: Object.keys(state.timeline).length, completed: Boolean(state.finalReport) }; return result(JSON.stringify(input.action === "export" ? state : summary, null, 2), state); }
			if (input.action === "set_scope") { const assets = clean([...(input.assets ?? []), ...(input.target ? [input.target] : [])]); if (input.authorized !== true || !input.authority?.trim() || !assets.length) return result("authorized=true, authority, and assets are required", state, true); const next = mutate("Updated scope", (draft) => { draft.scope = { authorized: true, authority: input.authority!.trim(), assets, exclusions: clean(input.exclusions), rules: clean(input.rules), validUntil: input.validUntil?.trim() || undefined }; }); return result("Authorized scope updated", next); }
			if (input.action === "set_controls") { const next = mutate("Updated controls", (draft) => { if (input.paused !== undefined) draft.paused = input.paused; if (input.killSwitch !== undefined) draft.killSwitch = input.killSwitch; if (input.paused === false) { const loop = ensureLoopProtectionState(draft); loop.repeatedErrorCount = 0; delete loop.lastErrorFingerprint; delete loop.pauseReason; } }); return result(`paused=${next.paused}, killSwitch=${next.killSwitch}`, next); }
			if (input.action === "set_phase") { if (!input.phase) return result("phase is required", state, true); if (input.phase !== "detect" && !Object.values(state.evidence).some((entry) => entry.status === "valid")) return result("Evidence is required before leaving detect", state, true); const next = mutate(`Set phase ${input.phase}`, (draft) => { draft.phase = input.phase!; }); return result(`Phase: ${next.phase}`, next); }
			if (input.action === "add_task") { if (!input.objective?.trim()) return result("objective is required", state, true); const parentId = input.parentId || state.rootTaskId; if (!state.tasks[parentId]) return result("Unknown parentId", state, true); const dependencies = clean(input.dependencies); if (dependencies.some((id) => !state!.tasks[id])) return result("Unknown dependency", state, true); const taskId = input.taskId?.trim() || makeId("task"); if (state.tasks[taskId]) return result(`Task ${taskId} already exists; do not replay it`, state, true); const next = mutate(`Added ${taskId}`, (draft) => { draft.tasks[taskId] = { taskId, parentId, objective: input.objective!.trim(), objectiveKind: input.objectiveKind ?? "procedure", status: "todo", priority: input.priority ?? 50, requiredEvidence: clean(input.requiredEvidence), evidenceRefs: [], dependencies, riskLevel: input.riskLevel ?? "low", assignedRole: input.assignedRole ?? "planner", createdFrom: "planner", notes: [] }; }); return result(`Added IRT task ${taskId}`, next); }
			if (input.action === "plan") { const task = activeTasks(state).find((item) => item.dependencies.every((id) => terminalTasks.has(state!.tasks[id]?.status))); if (!task) return result("No ready task remains", state); const next = mutate(`Planner selected ${task.taskId}`, (draft) => { draft.tasks[task.taskId].status = "running"; }); return result(JSON.stringify({ role: "Planner", task: next.tasks[task.taskId] }, null, 2), next); }
			if (input.action === "propose_action") { const blocked = scopeBlock(state); if (blocked) return result(blocked, state, true); const task = input.taskId ? state.tasks[input.taskId] : undefined; if (!task || terminalTasks.has(task.status)) return result("Valid active taskId required", state, true); if (!input.actionType || !input.purpose?.trim() || !input.procedure?.trim() || !input.expectedEvidence?.length) return result("actionType, purpose, procedure, expectedEvidence required", state, true); const mutates = input.mutatesTarget ?? ["contain", "eradicate", "recover"].includes(input.actionType); if (mutates && !input.rollbackPlan?.trim()) return result("rollbackPlan required", state, true); const actionId = input.actionId?.trim() || makeId("action"); if (state.actions[actionId]) return result(`Action ${actionId} already exists; do not re-propose it`, state, true); const approvalRequired = mutates || input.riskLevel === "high" || input.riskLevel === "critical"; const next = mutate(`Proposed ${actionId}`, (draft) => { draft.actions[actionId] = { actionId, taskId: task.taskId, type: input.actionType!, purpose: input.purpose!.trim(), procedure: input.procedure!.trim(), expectedEvidence: clean(input.expectedEvidence), externalToolHint: input.externalToolHint?.trim() || "Select an existing CTF/Pi/MCP capability", riskLevel: input.riskLevel ?? "low", mutatesTarget: mutates, rollbackPlan: input.rollbackPlan?.trim() || "Not required", approvalRequired, status: "proposed", createdAt: now() }; }); return result(`Proposed ${actionId}; approvalRequired=${approvalRequired}; nothing executed.`, next); }
			if (input.action === "approve_action") { const action = input.actionId ? state.actions[input.actionId] : undefined; if (!action || action.status !== "proposed") return result("Proposed actionId required", state, true); const approved = !action.approvalRequired || Boolean(ctx.hasUI && await ctx.ui.confirm("Approve IRCopilot action", `${action.type}: ${action.purpose}\n${action.procedure}\nRollback: ${action.rollbackPlan}`)); if (!approved) { const next = mutate(`Blocked ${action.actionId} after approval denial`, (draft) => { draft.actions[action.actionId].status = "blocked"; draft.actions[action.actionId].completedAt = now(); }); return result(`Approval not granted; ${action.actionId} is blocked and cannot be retried. Request a new action if scope or approval changes.`, next, true); } const next = mutate(`Approved ${action.actionId}`, (draft) => { draft.actions[action.actionId].status = "approved"; draft.actions[action.actionId].approvedAt = now(); }); return result(`Approved ${action.actionId}`, next); }
			if (input.action === "start_action") { const blocked = scopeBlock(state); if (blocked) return result(blocked, state, true); const action = input.actionId ? state.actions[input.actionId] : undefined; if (!action || !["proposed", "approved"].includes(action.status)) return result("Proposed or approved actionId required", state, true); if (action.approvalRequired && action.status !== "approved") return result("Approval required", state, true); const next = mutate(`Started ${action.actionId}`, (draft) => { draft.actions[action.actionId].status = "in_progress"; draft.actions[action.actionId].startedAt = now(); }); return result(JSON.stringify({ actionId: action.actionId, procedure: action.procedure, expectedEvidence: action.expectedEvidence, externalToolHint: action.externalToolHint, instruction: "Use an existing CTF/Pi/MCP tool, then record_observation." }, null, 2), next); }
			if (input.action === "record_observation") { const task = input.taskId ? state.tasks[input.taskId] : undefined; const action = input.actionId ? state.actions[input.actionId] : undefined; if (!task) return result("Valid taskId required", state, true); if (input.actionId && (!action || action.status !== "in_progress" || action.taskId !== task.taskId)) return result("In-progress action for this task required", state, true); if (!input.summary?.trim() || !input.source?.trim() || !input.externalToolReference?.trim()) return result("summary, source, externalToolReference required", state, true); const sensitivity = input.sensitivity ?? "internal"; if (input.containsSecrets && sensitivity !== "secret") return result("Secret observations require sensitivity=secret", state, true); const observationId = input.observationId?.trim() || makeId("obs"); if (state.observations[observationId]) return result(`Observation ${observationId} already exists; do not replay it`, state, true); const next = mutate(`Observed ${observationId}`, (draft) => { draft.observations[observationId] = { observationId, actionId: action?.actionId, taskId: task.taskId, summary: clip(input.summary), source: input.source!.trim(), externalToolReference: input.externalToolReference!.trim(), artifacts: clean(input.artifacts), sensitivity, containsSecrets: input.containsSecrets ?? false, createdAt: now() }; if (action) { draft.actions[action.actionId].status = "observed"; draft.actions[action.actionId].completedAt = now(); } }); return result(`Recorded ${observationId}; analyze it next.`, next); }
			if (input.action === "analyze") { const task = input.taskId ? state.tasks[input.taskId] : undefined; const observation = input.observationId ? state.observations[input.observationId] : undefined; if (!task || (input.observationId && !observation)) return result("Valid taskId/observationId required", state, true); if (!input.summary?.trim() || !input.source?.trim()) return result("summary and source required", state, true); const evidenceId = makeId("evidence"); const evidence: EvidenceRecord = { evidenceId, observationId: observation?.observationId, taskId: task.taskId, kind: input.kind ?? "fact", summary: clip(input.summary), source: input.source.trim(), confidence: Math.max(0, Math.min(1, input.confidence ?? 0.5)), sensitivity: input.sensitivity ?? observation?.sensitivity ?? "internal", satisfies: clean(input.satisfies), relatedEvidenceIds: clean(input.relatedEvidenceIds), status: "valid", createdAt: now() }; if (input.taskStatus === "not_applicable" && task.objectiveKind === "objective") return result("Objective tasks cannot be not_applicable", state, true); const trial = { ...state, evidence: { ...state.evidence, [evidenceId]: evidence } }; if (input.taskStatus === "completed") { const error = completionError(trial, task, [...task.evidenceRefs, evidenceId]); if (error) return result(error, state, true); } const next = mutate(`Analyzed ${evidenceId}`, (draft) => { draft.evidence[evidenceId] = evidence; draft.tasks[task.taskId].evidenceRefs.push(evidenceId); if (input.findings?.length) draft.tasks[task.taskId].notes.push(...input.findings); if (input.taskStatus) draft.tasks[task.taskId].status = input.taskStatus; }); return result(JSON.stringify({ role: "Analyst", evidenceId, status: next.tasks[task.taskId].status }, null, 2), next); }
			if (input.action === "record_hypothesis" || input.action === "update_hypothesis") { if (!input.summary?.trim()) return result("summary required", state, true); const hypothesisId = input.hypothesisId?.trim() || makeId("hypothesis"); if (input.action === "update_hypothesis" && !state.hypotheses[hypothesisId]) return result("Unknown hypothesisId", state, true); const refs = clean(input.evidenceRefs); if (refs.some((ref) => !state!.evidence[ref])) return result("Unknown evidenceRef", state, true); const status = input.hypothesisStatus ?? "open"; if (["supported", "rejected"].includes(status) && !refs.length) return result("Concluded hypothesis requires evidence", state, true); const next = mutate(`Hypothesis ${hypothesisId}`, (draft) => { const createdAt = draft.hypotheses[hypothesisId]?.createdAt ?? now(); draft.hypotheses[hypothesisId] = { hypothesisId, statement: input.summary!.trim(), status, confidence: Math.max(0, Math.min(1, input.confidence ?? 0.5)), evidenceRefs: refs, createdAt, updatedAt: now() }; }); return result(`${hypothesisId}: ${status}`, next); }
			if (input.action === "record_timeline") { const refs = clean(input.evidenceRefs); if (!input.timestamp || !input.summary?.trim() || !input.asset?.trim() || !refs.length || refs.some((ref) => !state!.evidence[ref])) return result("timestamp, summary, asset, valid evidenceRefs required", state, true); const duplicate = Object.values(state.timeline).some((entry) => entry.timestamp === input.timestamp && entry.asset === input.asset!.trim() && entry.description === input.summary!.trim()); if (duplicate) return result("Equivalent timeline event already exists; do not replay it", state, true); const timelineId = makeId("timeline"); const next = mutate(`Timeline ${timelineId}`, (draft) => { draft.timeline[timelineId] = { timelineId, timestamp: input.timestamp!, description: input.summary!.trim(), asset: input.asset!.trim(), evidenceRefs: refs, createdAt: now() }; }); return result(`Recorded ${timelineId}`, next); }
			if (input.action === "reflect") { const violations: string[] = []; for (const task of Object.values(state.tasks)) if (task.status === "completed") { const error = completionError(state, task, task.evidenceRefs); if (error) violations.push(`${task.taskId}: ${error}`); } for (const action of Object.values(state.actions)) { if (action.status === "observed" && !Object.values(state.observations).some((observation) => observation.actionId === action.actionId)) violations.push(`${action.actionId}: no observation`); if (action.mutatesTarget && !action.rollbackPlan.trim()) violations.push(`${action.actionId}: no rollback plan`); } for (const hypothesis of Object.values(state.hypotheses)) if (["supported", "rejected"].includes(hypothesis.status) && !validEvidence(state, hypothesis.evidenceRefs).length) violations.push(`${hypothesis.hypothesisId}: no valid evidence`); const decision = violations.length ? "rollback_or_human_review" : "approve"; const next = mutate(`Reflector ${decision}`, (draft) => { draft.audit.push({ eventId: makeId("event"), type: "reflector", at: now(), detail: violations.join("; ") || "No violations" }); }); return result(JSON.stringify({ role: "Reflector", decision, violations, version: next.version }, null, 2), next, Boolean(violations.length)); }
			if (input.action === "cancel_action") { const action = input.actionId ? state.actions[input.actionId] : undefined; if (!action || terminalActions.has(action.status)) return result("Non-terminal actionId required", state, true); const next = mutate(`Cancelled ${action.actionId}`, (draft) => { draft.actions[action.actionId].status = "cancelled"; draft.actions[action.actionId].completedAt = now(); }); return result(`Cancelled ${action.actionId}`, next); }
			if (input.action === "finish") { const actions = Object.values(state.actions).filter((item) => !terminalActions.has(item.status)); const tasks = Object.values(state.tasks).filter((item) => !terminalTasks.has(item.status)); const hypotheses = Object.values(state.hypotheses).filter((item) => item.status === "open"); if (actions.length || tasks.length || hypotheses.length) return result(`Cannot finish: ${tasks.length} task(s), ${actions.length} action(s), ${hypotheses.length} hypothesis(es) open`, state, true); if (state.phase !== "recover") return result("Phase must be recover", state, true); const fields = [input.executiveSummary, input.scopeAndLimitations, input.timelineSummary, input.impact, input.responseAndRecovery, input.residualRisk, input.recommendations]; if (fields.some((field) => !field?.trim())) return result("All final report sections required", state, true); const next = mutate("Finished incident", (draft) => { draft.finalReport = { executiveSummary: input.executiveSummary!.trim(), scopeAndLimitations: input.scopeAndLimitations!.trim(), timeline: input.timelineSummary!.trim(), impact: input.impact!.trim(), responseAndRecovery: input.responseAndRecovery!.trim(), residualRisk: input.residualRisk!.trim(), recommendations: input.recommendations!.trim(), completedAt: now() }; }); return result(reportMarkdown(next), next); }
			if (input.action === "report") return result(reportMarkdown(state), state);
			if (input.action === "rollback") { const snapshot = input.snapshotVersion === undefined ? state.snapshots[0] : state.snapshots.find((item) => item.version === input.snapshotVersion); if (!snapshot) return result("No rollback snapshot", state, true); const restored = clone(snapshot); for (const evidence of Object.values(state.evidence)) if (!restored.evidence[evidence.evidenceId]) restored.evidence[evidence.evidenceId] = { ...evidence, status: "invalidated" }; restored.snapshots = state.snapshots.filter((item) => item.version !== snapshot.version).slice(0, MAX_SNAPSHOTS); persist(restored, `Rolled back to ${snapshot.version}`); return result(`Rolled back to ${snapshot.version}; later evidence invalidated.`, restored); }
			return result(`Unsupported action: ${input.action}`, state, true);
		},
	});

	pi.registerCommand("ircopilot", { description: "Show the current IRCopilot incident summary", handler: async (_args, ctx) => { if (!state) return ctx.ui.notify("IRCopilot has no active incident.", "info"); ctx.ui.notify(`${state.incidentId} - ${state.phase} - ${activeTasks(state).length} active task(s) - v${state.version}`, "info"); } });
	pi.registerCommand("ircopilot-reset", { description: "Reset the current IRCopilot incident after confirmation", handler: async (_args, ctx) => { if (!ctx.hasUI || !(await ctx.ui.confirm("Reset IRCopilot incident", "This clears the active incident state."))) return; state = undefined; pi.appendEntry("ircopilot-reset", { at: now() }); ctx.ui.notify("IRCopilot state reset.", "info"); } });
}
