import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionContext, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { SecHeurConfig } from "./config.ts";

export type ProgressJudgeStatus = "on_track" | "course_correct" | "stuck" | "flag_found" | "off_track";

export interface ProgressJudgeResult {
	turn: number;
	status: ProgressJudgeStatus;
	summary: string;
	suggestion: string;
	confidence: number;
	message: string;
	model: string;
	source: "model" | "manual";
	timestamp: number;
}

export type ProgressJudgeContext = Pick<ExtensionContext, "model" | "modelRegistry" | "signal">;

const VALID_STATUSES = new Set<ProgressJudgeStatus>(["on_track", "course_correct", "stuck", "flag_found", "off_track"]);

const DEFAULT_SYSTEM_PROMPT = `You are a progress judge for an autonomous agent solving a challenge.
Do not solve the challenge. Assess progress and suggest a course correction only when needed.
Return one JSON object with status, summary, suggestion, and confidence.
Valid statuses: on_track, course_correct, stuck, flag_found, off_track.`;

function readText(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return readFileSync(path, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

function judgeSystemPrompt(config: SecHeurConfig): string {
	return (
		readText(join(config.projectRoot, ".secheur-agent", "judge_prompt.md")) ??
		readText(join(config.legacyRoot, "assets", "judge_prompt.txt")) ??
		DEFAULT_SYSTEM_PROMPT
	);
}

function boundedConversation(messages: ReturnType<typeof convertToLlm>, characterBudget: number): string {
	const parts: string[] = [];
	let remaining = characterBudget;
	for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
		let part = serializeConversation([messages[index]]).trim();
		if (!part) continue;
		if (part.length > 2500) part = `${part.slice(0, 2500)}\n[message truncated]`;
		if (part.length > remaining) part = `${part.slice(0, Math.max(0, remaining - 20))}\n[history truncated]`;
		parts.push(part);
		remaining -= part.length;
	}
	return parts.reverse().join("\n\n");
}

export function buildProgressJudgeInput(messages: AgentMessage[], maxHistoryMessages: number, note = ""): string {
	const converted = convertToLlm(messages);
	const firstUser = converted.find((message) => message.role === "user");
	const originalTask = firstUser
		? serializeConversation([firstUser])
				.replace(/^\[User\]:\s*/u, "")
				.slice(0, 4000)
		: "";
	const split = Math.max(0, converted.length - maxHistoryMessages);
	const older = converted.slice(0, split);
	const recent = converted.slice(split);
	const sections = [`## Original task\n${originalTask || "(no task)"}`];
	const olderHistory = boundedConversation(older, 4000);
	if (olderHistory) sections.push(`## Older history (truncated)\n${olderHistory}`);
	sections.push(`## Recent messages\n${boundedConversation(recent, 12_000) || "(no messages)"}`);
	if (note.trim()) sections.push(`## Agent note\n${note.trim().slice(0, 2000)}`);
	return sections.join("\n\n");
}

function parsedObject(rawText: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(rawText);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		const start = rawText.indexOf("{");
		const end = rawText.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				const parsed: unknown = JSON.parse(rawText.slice(start, end + 1));
				if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
					return parsed as Record<string, unknown>;
				}
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

function resultMessage(summary: string, suggestion: string): string {
	return [summary, suggestion].filter(Boolean).join(" Next: ");
}

export function parseProgressJudgeResult(
	rawText: string,
	turn: number,
	model: string,
	timestamp = Date.now(),
): ProgressJudgeResult {
	const parsed = parsedObject(rawText.trim());
	if (!parsed) {
		return {
			turn,
			status: "on_track",
			summary: "Judge response could not be parsed.",
			suggestion: "",
			confidence: 0,
			message: "Judge response could not be parsed.",
			model,
			source: "model",
			timestamp,
		};
	}
	const requestedStatus = typeof parsed.status === "string" ? parsed.status : "";
	const status = VALID_STATUSES.has(requestedStatus as ProgressJudgeStatus)
		? (requestedStatus as ProgressJudgeStatus)
		: "on_track";
	const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
	const parsedSuggestion = typeof parsed.suggestion === "string" ? parsed.suggestion.trim() : "";
	const suggestion = status === "on_track" || status === "flag_found" ? "" : parsedSuggestion;
	const rawConfidence = typeof parsed.confidence === "number" ? parsed.confidence : Number(parsed.confidence);
	const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0;
	return {
		turn,
		status,
		summary,
		suggestion,
		confidence,
		message: resultMessage(summary, suggestion),
		model,
		source: "model",
		timestamp,
	};
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.flatMap((content) => (content.type === "text" ? [content.text] : []))
		.join("\n")
		.trim();
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function selectedJudgeModel(config: SecHeurConfig, ctx: ProgressJudgeContext): Model<Api> | undefined {
	const requested = config.judge.modelProfile;
	if (!requested) return ctx.model;
	const models = ctx.modelRegistry.getAll();
	if (/^\d+$/u.test(requested)) return models[Number(requested)] ?? ctx.model;
	const exact = models.find((model) => modelKey(model) === requested);
	if (exact) return exact;
	if (ctx.model && (ctx.model.provider === requested || ctx.model.id === requested || ctx.model.name === requested)) {
		return ctx.model;
	}
	const matches = models.filter(
		(model) => model.provider === requested || model.id === requested || model.name === requested,
	);
	return matches.find((model) => ctx.modelRegistry.hasConfiguredAuth(model)) ?? matches[0] ?? ctx.model;
}

function manualStatus(requestedStatus: string | undefined): ProgressJudgeStatus {
	const normalized = requestedStatus?.trim().toLowerCase();
	if (normalized === "complete" || normalized === "completed" || normalized === "flag_found") return "flag_found";
	if (normalized === "blocked" || normalized === "stuck") return "stuck";
	if (normalized === "course_correct" || normalized === "off_track") return normalized;
	return "on_track";
}

export function formatProgressJudgeReminder(result: ProgressJudgeResult): string {
	if (result.status === "on_track") return "";
	const lines = [
		"<system-reminder>",
		`[Progress Judge] status=${result.status} confidence=${result.confidence}`,
		`summary: ${result.summary}`,
	];
	if (result.suggestion) lines.push("", "suggestion:", result.suggestion);
	lines.push("</system-reminder>");
	return lines.join("\n");
}

export class ProgressJudge {
	private turnCount = 0;
	private evaluatedTurn = 0;
	private lastResult?: ProgressJudgeResult;
	private lastError?: string;
	private latestMessages: AgentMessage[] = [];
	private readonly config: SecHeurConfig;

	constructor(config: SecHeurConfig) {
		this.config = config;
	}

	beginTurn(): void {
		this.turnCount += 1;
	}

	record(note = "", requestedStatus?: string): ProgressJudgeResult | undefined {
		if (!this.config.judge.enabled) return undefined;
		const status = manualStatus(requestedStatus);
		const summary =
			note.trim() || (status === "on_track" ? "Agent reports forward progress." : `Agent reports ${status}.`);
		this.lastResult = {
			turn: this.turnCount,
			status,
			summary,
			suggestion: "",
			confidence: 1,
			message: summary,
			model: "manual",
			source: "manual",
			timestamp: Date.now(),
		};
		return this.lastResult;
	}

	async evaluate(
		messages: AgentMessage[] | undefined,
		ctx: ProgressJudgeContext,
		options: { force?: boolean; note?: string } = {},
	): Promise<ProgressJudgeResult | undefined> {
		if (messages) this.latestMessages = [...messages];
		if (!this.config.judge.enabled) return undefined;
		if (!options.force && this.turnCount % this.config.judge.everyNTurns !== 0) return undefined;
		if (!options.force && this.evaluatedTurn === this.turnCount) return undefined;
		if (!options.force) this.evaluatedTurn = this.turnCount;
		const model = selectedJudgeModel(this.config, ctx);
		if (!model) {
			this.lastError = "Progress Judge has no model available";
			return undefined;
		}
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
			this.lastError = `Progress Judge has no authentication for ${modelKey(model)}`;
			return undefined;
		}
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: judgeSystemPrompt(this.config),
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: buildProgressJudgeInput(
										this.latestMessages,
										this.config.judge.maxHistoryMessages,
										options.note,
									),
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{
					signal: ctx.signal,
					maxTokens: 700,
					temperature: 0,
					cacheRetention: "none",
					sessionId: randomUUID(),
				},
			);
			if (response.stopReason === "error") {
				throw new Error(response.errorMessage || "Judge model returned an error");
			}
			this.lastResult = parseProgressJudgeResult(assistantText(response), this.turnCount, modelKey(model));
			this.lastError = undefined;
			return this.lastResult;
		} catch (error) {
			if (ctx.signal?.aborted) return undefined;
			this.lastError = error instanceof Error ? error.message : String(error);
			console.error(`[judge] evaluation failed: ${this.lastError}`);
			return undefined;
		}
	}

	get turns(): number {
		return this.turnCount;
	}

	get last(): ProgressJudgeResult | undefined {
		return this.lastResult;
	}

	get error(): string | undefined {
		return this.lastError;
	}
}
