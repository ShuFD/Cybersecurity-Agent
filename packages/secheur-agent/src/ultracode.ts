import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadSecHeurConfig, type SecHeurConfig } from "./config.ts";
import { flagOracleConfigured } from "./flag-oracle.ts";
import { type PiCodingTaskResult, runPiCodingTask } from "./subagent.ts";
import {
	getDefaultVerifierPython,
	runVerifier,
	type VerifierCandidate,
	type VerifierRuntimeConfig,
	type VerifierSelection,
} from "./ultracode-verifier.ts";
import {
	applyPatch,
	type CandidateSnapshot,
	type CandidateWorktree,
	cleanupWorktreeSession,
	createWorktreeSession,
	detectVerificationCommand,
	mapWithConcurrencyLimit,
	runVerification,
	snapshotCandidate,
	truncateOutput,
	type UltracodeWorktreeSession,
	type VerificationResult,
} from "./ultracode-worktree.ts";

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
const CANDIDATE_COUNT = 5;
const CANDIDATE_CONCURRENCY = 5;
const CANDIDATE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const TRACE_LIMIT = 180 * 1024;
const DEFAULT_CANDIDATE_MODELS = [
	"secheur-deepseek/deepseek-v4-flash",
	"deepseek/deepseek-v4-flash",
	"deepseek/deepseek-reasoner",
	"deepseek/deepseek-chat",
];
const DEFAULT_ULTRACODE_THINKING_LEVEL: ThinkingLevel = "max";
const ULTRACODE_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const FLAG_VERIFICATION_MODES = ["auto", "required", "off"] as const;

const CANDIDATE_SYSTEM_PROMPT = `You are one of five independent implementation candidates in an ultracode run.

Work autonomously in the current Git worktree. Implement the user's task completely and safely. Inspect the repository before editing, preserve unrelated work, use the available tools, and run the most relevant checks you can identify. Do not invoke ultracode or delegate to another subagent. Your worktree is isolated from the other candidates.

When finished, give a concise final report containing what changed, files changed, tests/checks run, and any remaining risk. The code and worktree diff are the source of truth.`;

interface CandidateRun {
	worktree: CandidateWorktree;
	result?: PiCodingTaskResult;
	snapshot?: CandidateSnapshot;
	error?: string;
}

export type UltracodeFlagVerificationMode = (typeof FLAG_VERIFICATION_MODES)[number];

export interface UltracodeFlagVerificationResult {
	correct: boolean;
	status?: string;
}

export type UltracodeFlagVerifier = (
	flag: string,
	challengeId: string | undefined,
	signal: AbortSignal,
) => Promise<UltracodeFlagVerificationResult>;

export interface UltracodeExtensionOptions {
	verifyFlag?: UltracodeFlagVerifier;
}

export interface UltracodeFlagVerificationReport {
	status: "verified" | "skipped";
	reason: string;
	candidateIndex?: number;
}

export interface UltracodeRunReport {
	task: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	verifierModel: string;
	flagVerification: UltracodeFlagVerificationReport;
	completedCandidates: number;
	failedCandidates: Array<{ index: number; error: string }>;
	selection: VerifierSelection;
	winnerIndex: number;
	winnerStat: string;
	verification: VerificationResult;
	postApplyCheck: VerificationResult;
}

export function resolveUltracodeThinkingLevel(): ThinkingLevel {
	const configured = process.env.ULTRACODE_THINKING_LEVEL?.trim();
	if (!configured) return DEFAULT_ULTRACODE_THINKING_LEVEL;
	if ((ULTRACODE_THINKING_LEVELS as readonly string[]).includes(configured)) {
		return configured as ThinkingLevel;
	}
	throw new Error(`ULTRACODE_THINKING_LEVEL must be one of: ${ULTRACODE_THINKING_LEVELS.join(", ")}`);
}

export function resolveUltracodeFlagVerificationMode(): UltracodeFlagVerificationMode {
	const configured = process.env.ULTRACODE_FLAG_VERIFY?.trim().toLowerCase();
	if (!configured) return "auto";
	if ((FLAG_VERIFICATION_MODES as readonly string[]).includes(configured)) {
		return configured as UltracodeFlagVerificationMode;
	}
	throw new Error(`ULTRACODE_FLAG_VERIFY must be one of: ${FLAG_VERIFICATION_MODES.join(", ")}`);
}

export function extractUltracodeFlagCandidates(text: string): string[] {
	const tagged = [...text.matchAll(/<FINAL_ANSWER>\s*(.*?)\s*<\/FINAL_ANSWER>/gis)]
		.map((match) => match[1]?.trim() ?? "")
		.filter(Boolean);
	if (tagged.length > 0) return [...new Set(tagged)];
	return [...new Set([...text.matchAll(/\b[A-Za-z0-9_.-]{0,40}\{[^{}\s]{1,300}\}/g)].map((match) => match[0]))];
}

function resolveChallengeId(task: string): string | undefined {
	for (const key of [
		"ULTRACODE_CHALLENGE_ID",
		"CTF_CHALLENGE_ID",
		"SECHEUR_TARGET_ID",
		"CTF_TARGET_ID",
		"TARGET_ID",
		"SECHEUR_CHALLENGE_ID",
	]) {
		const value = process.env[key]?.trim();
		if (value) return value;
	}
	const match = task.match(/(?:Target|Challenge|CTF Challenge)\s+ID\s*[:=]\s*([^\s]+)/i);
	return match?.[1]?.replace(/[),.;]+$/u, "") || undefined;
}

function isFlagTask(task: string, challengeId: string | undefined): boolean {
	return Boolean(challengeId || /\b(?:ctf|flag|challenge|target\s+id|pwn|crypto|reverse|misc|web)\b/i.test(task));
}

function getTextParts(value: unknown): string[] {
	if (!value || typeof value !== "object") return [];
	const message = value as { content?: unknown };
	if (!Array.isArray(message.content)) return [];
	return message.content.flatMap((part) => {
		if (!part || typeof part !== "object") return [];
		const item = part as { type?: unknown; text?: unknown; name?: unknown };
		if (item.type === "text" && typeof item.text === "string") return [item.text];
		if (item.type === "toolCall" && typeof item.name === "string") return [`[tool:${item.name}]`];
		return [];
	});
}

function buildConversationContext(ctx: ExtensionContext): string {
	const lines: string[] = [];
	for (const entry of ctx.sessionManager.getBranch().slice(-16)) {
		if (entry.type === "message") {
			const text = getTextParts(entry.message).join("\n").trim();
			if (text) lines.push(`${entry.message.role}: ${text}`);
		}
		if (entry.type === "custom_message") {
			const text = getTextParts({ content: entry.content }).join("\n").trim();
			if (text) lines.push(`context: ${text}`);
		}
	}
	return truncateOutput(lines.join("\n\n"), 32 * 1024);
}

function buildCandidateTask(task: string, context: string): string {
	const contextBlock = context ? `\n\nRelevant prior conversation context:\n${context}` : "";
	return `Original user task:\n${task}${contextBlock}`;
}

function modelLabel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function findModel(ctx: ExtensionContext, spec: string): Model<Api> | undefined {
	const normalized = spec.trim();
	if (!normalized) return undefined;
	const separator = normalized.indexOf("/");
	if (separator > 0) {
		const provider = normalized.slice(0, separator);
		const modelId = normalized.slice(separator + 1);
		return ctx.modelRegistry.find(provider, modelId);
	}
	return ctx.modelRegistry.getAll().find((model) => model.id === normalized);
}

function resolveCandidateModel(ctx: ExtensionContext): Model<Api> {
	const explicit = process.env.ULTRACODE_AGENT_MODEL?.trim();
	if (explicit) {
		const model = findModel(ctx, explicit);
		if (!model) throw new Error(`Ultracode candidate model is not configured in Pi: ${explicit}`);
		return model;
	}
	for (const spec of DEFAULT_CANDIDATE_MODELS) {
		const model = findModel(ctx, spec);
		if (model) return model;
	}
	const active = ctx.model as Model<Api> | undefined;
	if (active?.provider.toLowerCase().includes("deepseek") || active?.id.toLowerCase().includes("deepseek")) {
		return active;
	}
	throw new Error(
		`No DeepSeek model is configured for ultracode. Set ULTRACODE_AGENT_MODEL=provider/model or add a DeepSeek provider to Pi models.json.`,
	);
}

function parseHeaders(value: string | undefined): Record<string, string> {
	if (!value?.trim()) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const headers: Record<string, string> = {};
		for (const [key, item] of Object.entries(parsed)) {
			if (typeof item === "string") headers[key] = item;
		}
		return headers;
	} catch {
		throw new Error("ULTRACODE_VERIFIER_HEADERS must be a JSON object");
	}
}

async function resolveVerifierConfig(
	ctx: ExtensionContext,
	candidateModel: Model<Api>,
): Promise<VerifierRuntimeConfig> {
	const verifierSpec = process.env.ULTRACODE_VERIFIER_MODEL?.trim();
	const model = verifierSpec ? findModel(ctx, verifierSpec) : candidateModel;
	if (!model) throw new Error(`Ultracode verifier model is not configured in Pi: ${verifierSpec}`);
	const verifierApi = process.env.ULTRACODE_VERIFIER_API?.trim() || model.api;
	if (verifierApi !== "openai-completions" && verifierApi !== "openai-responses") {
		throw new Error(
			`Ultracode verifier requires an OpenAI-compatible completions or responses model; ${modelLabel(model)} uses ${verifierApi}`,
		);
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`Could not resolve verifier credentials: ${auth.error}`);
	const headers: Record<string, string> = {};
	for (const source of [model.headers, auth.headers, parseHeaders(process.env.ULTRACODE_VERIFIER_HEADERS)]) {
		for (const [key, value] of Object.entries(source ?? {})) {
			if (typeof value === "string") headers[key] = value;
		}
	}
	const apiKey = process.env.ULTRACODE_VERIFIER_API_KEY?.trim() || auth.apiKey;
	if (!apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
		throw new Error(`No usable API credential is configured for verifier model ${modelLabel(model)}`);
	}
	const baseUrl = (process.env.ULTRACODE_VERIFIER_BASE_URL?.trim() || auth.baseUrl || model.baseUrl).replace(
		/\/+$/,
		"",
	);
	if (!baseUrl) throw new Error(`Ultracode verifier has no base URL for ${modelLabel(model)}`);
	return {
		python: getDefaultVerifierPython(PACKAGE_ROOT),
		api: verifierApi,
		model: model.id,
		baseUrl,
		apiKey,
		headers,
		wholeEndpoint:
			process.env.ULTRACODE_VERIFIER_WHOLE_ENDPOINT === "1" ||
			/llm-gateway\.dasctf\.com\/.*\/proxy\/e\//u.test(baseUrl),
	};
}

function boundedNumber(name: string, fallback: number, minimum: number, maximum: number): number {
	const raw = process.env[name];
	if (!raw?.trim()) return fallback;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
	}
	return parsed;
}

function candidateTranscript(run: CandidateRun): string {
	return [
		`Candidate ${run.worktree.index + 1}`,
		`Status: ${run.result ? "completed" : "failed"}`,
		`Final report:\n${run.result?.finalText || run.error || "(no output)"}`,
		`Changed files:\n${run.snapshot?.stat || "(none)"}`,
		`Patch:\n${truncateOutput(run.snapshot?.patch || "(no patch)", TRACE_LIMIT)}`,
	].join("\n\n");
}

function verifierCriteria(): Record<string, string> {
	return {
		correctness: "Does the candidate fully and technically correctly solve the original task?",
		completeness: "Does it cover the requested behavior, interfaces, edge cases, and release requirements?",
		verification: "Does the candidate provide credible tests or checks that support the claimed result?",
		safety: "Does it preserve unrelated changes, avoid unsafe behavior, and keep the implementation maintainable?",
	};
}

async function runCandidates(
	session: UltracodeWorktreeSession,
	task: string,
	ctx: ExtensionContext,
	signal: AbortSignal,
	model: Model<Api>,
	config: SecHeurConfig,
	thinkingLevel: ThinkingLevel,
): Promise<CandidateRun[]> {
	const fullTask = buildCandidateTask(task, buildConversationContext(ctx));
	let completed = 0;
	return mapWithConcurrencyLimit(session.candidates, CANDIDATE_CONCURRENCY, async (worktree) => {
		const run: CandidateRun = { worktree };
		try {
			run.result = await runPiCodingTask({
				config,
				task: fullTask,
				cwd: worktree.cwd,
				model,
				thinkingLevel,
				systemPrompt: CANDIDATE_SYSTEM_PROMPT,
				allowedTools: CANDIDATE_TOOLS,
				signal,
				onUpdate: () => {
					if (ctx.hasUI)
						ctx.ui.setStatus("ultracode", `ultracode: ${completed}/${CANDIDATE_COUNT} candidates complete`);
				},
			});
			run.snapshot = await snapshotCandidate(session, worktree);
		} catch (error) {
			run.error = error instanceof Error ? error.message : String(error);
		}
		completed += 1;
		if (ctx.hasUI) ctx.ui.setStatus("ultracode", `ultracode: ${completed}/${CANDIDATE_COUNT} candidates complete`);
		return run;
	});
}

async function verifyWinnerFlag(
	task: string,
	selected: CandidateRun & { result: PiCodingTaskResult; snapshot: CandidateSnapshot },
	verification: VerificationResult,
	signal: AbortSignal,
	verifyFlag: UltracodeFlagVerifier | undefined,
): Promise<UltracodeFlagVerificationReport> {
	const mode = resolveUltracodeFlagVerificationMode();
	if (mode === "off") return { status: "skipped", reason: "disabled by ULTRACODE_FLAG_VERIFY" };

	const challengeId = resolveChallengeId(task);
	if (mode === "auto" && !isFlagTask(task, challengeId)) {
		return { status: "skipped", reason: "task is not classified as a flag challenge" };
	}
	if (!flagOracleConfigured()) {
		if (mode === "required") {
			throw new Error("Ultracode flag verification is required, but the Flag Oracle is not configured");
		}
		return { status: "skipped", reason: "Flag Oracle is not configured" };
	}
	if (!verifyFlag) {
		throw new Error("Ultracode flag verification is configured, but no Flag Oracle bridge is available");
	}

	const evidence = [verification.stdout, verification.stderr, selected.result.finalText].filter(Boolean).join("\n");
	const flags = extractUltracodeFlagCandidates(evidence);
	if (flags.length !== 1) {
		throw new Error(
			`Flag Oracle verification requires exactly one evidence-backed flag; winner candidate ${selected.worktree.index + 1} produced ${flags.length}`,
		);
	}

	const result = await verifyFlag(flags[0], challengeId, signal);
	if (!result.correct) {
		throw new Error(
			`Flag Oracle rejected winner candidate ${selected.worktree.index + 1}${result.status ? ` (${result.status})` : ""}`,
		);
	}
	return {
		status: "verified",
		reason: "Flag Oracle accepted the candidate",
		candidateIndex: selected.worktree.index + 1,
	};
}

export async function executeUltracode(
	task: string,
	ctx: ExtensionContext,
	signal: AbortSignal,
	options: UltracodeExtensionOptions = {},
): Promise<UltracodeRunReport> {
	const candidateModel = resolveCandidateModel(ctx);
	const thinkingLevel = resolveUltracodeThinkingLevel();
	const verifierConfig = await resolveVerifierConfig(ctx, candidateModel);
	const config = loadSecHeurConfig({ projectRoot: process.env.SECHEUR_PROJECT_ROOT?.trim() || ctx.cwd });
	const session = await createWorktreeSession(ctx.cwd, CANDIDATE_COUNT);
	try {
		if (ctx.hasUI) ctx.ui.setStatus("ultracode", "ultracode: running 5 isolated DeepSeek Pi candidates");
		const runs = await runCandidates(session, task, ctx, signal, candidateModel, config, thinkingLevel);
		const successful = runs.filter(
			(run): run is CandidateRun & { result: PiCodingTaskResult; snapshot: CandidateSnapshot } =>
				Boolean(run.result && run.snapshot),
		);
		const failedCandidates = runs
			.filter((run) => !successful.includes(run as (typeof successful)[number]))
			.map((run) => ({ index: run.worktree.index + 1, error: run.error || "candidate failed" }));
		if (successful.length < 2) {
			throw new Error(
				`Only ${successful.length} of ${CANDIDATE_COUNT} candidates completed; at least 2 are required for verification`,
			);
		}

		if (ctx.hasUI)
			ctx.ui.setStatus("ultracode", `ultracode: verifying ${successful.length} candidates with LLM-as-a-Verifier`);
		const verifierCandidates: VerifierCandidate[] = successful.map((run) => ({
			index: run.worktree.index,
			transcript: candidateTranscript(run),
		}));
		const selection = await runVerifier(
			{
				problem: task,
				candidates: verifierCandidates,
				criteria: verifierCriteria(),
				model: verifierConfig.model,
				nEvaluations: boundedNumber("ULTRACODE_VERIFIER_EVALUATIONS", 4, 1, 20),
				pivots: boundedNumber("ULTRACODE_VERIFIER_PIVOTS", 2, 1, 20),
				maxWorkers: boundedNumber("ULTRACODE_VERIFIER_WORKERS", 8, 1, 100),
				seed: boundedNumber("ULTRACODE_VERIFIER_SEED", 0, 0, 2_147_483_647),
				cache: process.env.ULTRACODE_VERIFIER_CACHE,
			},
			verifierConfig,
			PACKAGE_ROOT,
			signal,
		);
		const selected = successful[selection.index];
		if (!selected) throw new Error(`Verifier selected invalid candidate index ${selection.index}`);

		const verificationCommand = detectVerificationCommand(session.repoRoot);
		if (ctx.hasUI) ctx.ui.setStatus("ultracode", `ultracode: validating candidate ${selected.worktree.index + 1}`);
		const verification = await runVerification(selected.worktree.root, verificationCommand, signal);
		if (verification.code !== 0) {
			throw new Error(
				`Winner candidate ${selected.worktree.index + 1} failed ${verification.command}:\n${truncateOutput(verification.stderr || verification.stdout)}`,
			);
		}
		const flagVerification = await verifyWinnerFlag(task, selected, verification, signal, options.verifyFlag);

		const verifiedSnapshot = await snapshotCandidate(session, selected.worktree);
		await applyPatch(session.repoRoot, verifiedSnapshot.patch);
		const postApplyCheck = await runVerification(session.repoRoot, undefined, signal);
		return {
			task,
			model: modelLabel(candidateModel),
			thinkingLevel,
			verifierModel: verifierConfig.model,
			flagVerification,
			completedCandidates: successful.length,
			failedCandidates,
			selection,
			winnerIndex: selected.worktree.index + 1,
			winnerStat: verifiedSnapshot.stat,
			verification,
			postApplyCheck,
		};
	} finally {
		await cleanupWorktreeSession(session);
	}
}

function formatReport(report: UltracodeRunReport): string {
	const ranking = report.selection.ranking
		.map((index) => `${index + 1} (${report.selection.scores[index]?.toFixed(3) ?? "n/a"})`)
		.join(" > ");
	const failed = report.failedCandidates.length
		? report.failedCandidates.map((item) => `candidate ${item.index}: ${truncateOutput(item.error, 600)}`).join("; ")
		: "none";
	return [
		"## Ultracode result",
		"",
		"The ultracode orchestrator completed one task using five isolated DeepSeek Pi candidates and an LLM verifier.",
		"",
		`Original task: ${report.task}`,
		`Candidate model: ${report.model}`,
		`Candidate thinking level: ${report.thinkingLevel}`,
		`Verifier model: ${report.verifierModel}`,
		`Flag Oracle: ${report.flagVerification.status} (${report.flagVerification.reason})`,
		`Candidates completed: ${report.completedCandidates}/5`,
		`Failed candidates: ${failed}`,
		`Verifier ranking: ${ranking || "unavailable"}`,
		`Winner applied: candidate ${report.winnerIndex}`,
		`Winner changes:\n${report.winnerStat || "(no tracked changes)"}`,
		`Validation: ${report.verification.command} (exit ${report.verification.code})`,
		`Post-apply diff check: ${report.postApplyCheck.code === 0 ? "passed" : "failed"}`,
		"",
		"You are the Main Agent. Inspect the applied changes, run any additional project-specific checks needed, and give the final answer for the original task. Do not start another ultracode run for this report.",
	].join("\n");
}

function formatFailure(task: string, error: unknown): string {
	return [
		"## Ultracode failed",
		"",
		`Original task: ${task}`,
		`No winner was applied. ${error instanceof Error ? error.message : String(error)}`,
		"",
		"You are the Main Agent. Explain the failure and decide whether a normal non-ultracode response is appropriate. Do not retry ultracode automatically.",
	].join("\n");
}

export function registerUltracodeExtension(pi: ExtensionAPI, options: UltracodeExtensionOptions = {}): void {
	let enabled = false;
	let skipNext = false;
	let running = false;
	let activeController: AbortController | undefined;

	if (typeof pi.registerFlag === "function") {
		pi.registerFlag("ultracode", {
			description: "Enable continuous ultracode orchestration",
			type: "boolean",
			default: false,
		});
	}

	const updateStatus = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus("ultracode", enabled ? "ultracode:on" : undefined);
	};

	const sendToMainAgent = (message: string) => {
		pi.sendUserMessage(message, { deliverAs: "followUp" });
	};

	const executeAndReturn = async (task: string, ctx: ExtensionContext): Promise<void> => {
		if (running) {
			if (ctx.hasUI) ctx.ui.notify("An ultracode run is already active", "warning");
			return;
		}
		running = true;
		activeController = new AbortController();
		try {
			const report = await executeUltracode(task, ctx, activeController.signal, options);
			sendToMainAgent(formatReport(report));
		} catch (error) {
			if (!activeController.signal.aborted) {
				if (ctx.hasUI)
					ctx.ui.notify(`Ultracode failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				sendToMainAgent(formatFailure(task, error));
			}
		} finally {
			activeController = undefined;
			running = false;
			updateStatus(ctx);
		}
	};

	const tool: ToolDefinition = {
		name: "ultracode",
		label: "Ultracode",
		description:
			"Run five isolated DeepSeek Pi coding candidates, have an LLM verifier select one, and apply only the verified winner. Use only when the user explicitly asks for ultracode.",
		parameters: Type.Object({ task: Type.String() }, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			if (running) throw new Error("An ultracode run is already active");
			const values = input && typeof input === "object" ? (input as { task?: unknown }) : {};
			const task = typeof values.task === "string" ? values.task.trim() : "";
			if (!task) throw new Error("ultracode requires a non-empty task");
			const controller = signal ? undefined : new AbortController();
			running = true;
			try {
				const report = await executeUltracode(
					task,
					ctx,
					signal ?? controller?.signal ?? new AbortController().signal,
					options,
				);
				return {
					content: [{ type: "text", text: formatReport(report) }],
					details: report,
				};
			} finally {
				running = false;
			}
		},
	};
	pi.registerTool(tool);

	pi.registerCommand("ultracode", {
		description: "Run or control the five-agent ultracode mode",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (input === "on") {
				enabled = true;
				skipNext = false;
				if (ctx.hasUI) ctx.ui.notify("Ultracode enabled", "info");
				updateStatus(ctx);
				return;
			}
			if (input === "off") {
				enabled = false;
				skipNext = false;
				if (ctx.hasUI) ctx.ui.notify("Ultracode disabled", "info");
				updateStatus(ctx);
				return;
			}
			if (input === "status") {
				if (ctx.hasUI)
					ctx.ui.notify(`Ultracode is ${enabled ? "enabled" : "disabled"}${running ? " and busy" : ""}`, "info");
				return;
			}
			if (!input) {
				enabled = true;
				skipNext = false;
				if (ctx.hasUI) ctx.ui.notify("Ultracode enabled", "info");
				updateStatus(ctx);
				return;
			}
			if (input.startsWith("once ")) {
				await executeAndReturn(input.slice("once ".length).trim(), ctx);
				return;
			}
			await executeAndReturn(input, ctx);
		},
	});

	pi.registerCommand("normal", {
		description: "Skip ultracode for the next user task",
		handler: async (_args, ctx) => {
			if (!enabled) {
				if (ctx.hasUI) ctx.ui.notify("Ultracode is already disabled", "info");
				return;
			}
			skipNext = true;
			if (ctx.hasUI) ctx.ui.notify("The next task will use the normal Main Agent", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		enabled =
			(typeof pi.getFlag === "function" && pi.getFlag("ultracode") === true) ||
			process.env.ULTRACODE_MODE === "auto";
		updateStatus(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return;
		if (!enabled) return;
		if (skipNext) {
			skipNext = false;
			return;
		}
		if (!event.text.trim()) return;
		if (event.images && event.images.length > 0) {
			if (ctx.hasUI)
				ctx.ui.notify("Ultracode currently accepts text-only tasks; use /normal for image tasks", "warning");
			return { action: "handled" };
		}
		await executeAndReturn(event.text, ctx);
		return { action: "handled" };
	});

	pi.on("session_shutdown", async () => {
		activeController?.abort();
	});
}

export default registerUltracodeExtension;
