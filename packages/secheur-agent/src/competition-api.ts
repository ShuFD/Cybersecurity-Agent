import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SecHeurConfig } from "./config.ts";

export type SlabExerciseId = number | string;

export interface SlabAttachment {
	name: string;
	url: string;
	ext?: string;
}

export interface SlabExerciseSummary {
	id: SlabExerciseId;
	name: string;
	isOpen: boolean;
	hasSolved: boolean;
	category?: string;
	raw: Record<string, unknown>;
}

export interface SlabExerciseDetails extends SlabExerciseSummary {
	description: string;
	isNeedInit: boolean;
	isNeedCheck: boolean;
	endpointType?: string;
	attachments: SlabAttachment[];
	endpoints: unknown[];
	raw: Record<string, unknown>;
}

export function isEnvironmentBackedExercise(
	details: Pick<SlabExerciseDetails, "isNeedInit" | "isNeedCheck" | "endpointType" | "endpoints">,
): boolean {
	const endpointType = details.endpointType?.trim().toLowerCase();
	return Boolean(
		details.isNeedInit ||
			details.isNeedCheck ||
			details.endpoints.length > 0 ||
			(endpointType && endpointType !== "none"),
	);
}

export interface SlabMatchInfo {
	note: string;
	rule: string;
	raw: Record<string, unknown>;
}

export interface SlabOverview {
	stagePoint?: number;
	stageRank?: number;
	raw: Record<string, unknown>;
}

export interface SlabAnswerResult {
	correct: boolean;
	data: Record<string, unknown>;
	httpStatus?: number;
	businessCode?: string;
	status?: string;
	rawResponse?: Record<string, unknown>;
}

export interface SlabAgentApiOptions {
	baseUrl?: string;
	accessKey?: string;
	matchId?: string | number;
	env?: NodeJS.ProcessEnv;
	competitionEnvFile?: string;
	recoverAfterSubmit?: boolean;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

interface SlabEnvelope {
	code?: unknown;
	message?: unknown;
	data?: unknown;
}

export class SlabAgentApiError extends Error {
	readonly code?: string;
	readonly status?: number;
	readonly retryAfterMs?: number;
	readonly response?: Record<string, unknown>;

	constructor(
		message: string,
		code?: string,
		status?: number,
		retryAfterMs?: number,
		response?: Record<string, unknown>,
	) {
		super(message);
		this.name = "SlabAgentApiError";
		this.code = code;
		this.status = status;
		this.retryAfterMs = retryAfterMs;
		this.response = response;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function booleanValue(value: unknown, fallback = false): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") return !["", "0", "false", "no", "off"].includes(value.toLowerCase());
	return fallback;
}

function exerciseId(value: unknown): SlabExerciseId | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const normalized = value.trim();
		return /^\d+$/u.test(normalized) ? Number(normalized) : normalized;
	}
	return undefined;
}

function parseEnvFile(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	try {
		return Object.fromEntries(
			readFileSync(path, "utf8")
				.split(/\r?\n/u)
				.flatMap((line) => {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith("#")) return [];
					const separator = trimmed.indexOf("=");
					if (separator <= 0) return [];
					const key = trimmed.slice(0, separator).trim();
					if (key !== "SLAB_MATCH_HOST" && key !== "SLAB_MATCH_ID" && key !== "SLAB_AGENT_ACCESSKEY") return [];
					let value = trimmed.slice(separator + 1).trim();
					if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
						value = value.slice(1, -1);
					}
					return [[key, value]];
				}),
		);
	} catch {
		return {};
	}
}

function responsePreview(value: string): string {
	return value.replace(/(?:Bearer|X-Agent-AccessKey)\s*[:=]?\s+[^\s,;]+/giu, "[REDACTED]").slice(0, 500);
}

function retryAfterMs(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, Math.trunc(seconds * 1000));
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function envInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const value = Number(env[name] ?? fallback);
	return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

async function waitForSyncInterval(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	signal?.throwIfAborted();
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function requestSignal(
	parent: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const abort = () => controller.abort();
	parent?.addEventListener("abort", abort, { once: true });
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", abort);
		},
	};
}

function endpointConfig(value: string): { base: string; matchId?: string } {
	const normalized = value.trim().replace(/\/+$/u, "");
	if (!normalized) throw new SlabAgentApiError("SLAB_MATCH_HOST is empty");
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new SlabAgentApiError("SLAB_MATCH_HOST must be an HTTP URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new SlabAgentApiError("SLAB_MATCH_HOST must use HTTP or HTTPS");
	}
	const suffix = "/slab-match/api/v1/agent";
	const pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
	if (pathname === suffix) return { base: normalized };
	const matchPath = pathname === "/" ? undefined : pathname.split("/").filter(Boolean).at(-1);
	return { base: `${parsed.origin}${suffix}`, ...(matchPath ? { matchId: decodeURIComponent(matchPath) } : {}) };
}

export function ctfdAgentApiUrl(baseUrl: string): string {
	const normalized = baseUrl.trim().replace(/\/+$/u, "");
	const suffix = "/slab-match/api/v1/agent";
	return normalized.endsWith(suffix) ? normalized : `${normalized}${suffix}`;
}

function normalizeSummary(value: unknown, category?: string): SlabExerciseSummary | undefined {
	if (!isRecord(value)) return undefined;
	const id = exerciseId(value.id ?? value.exerciseId ?? value.exercise_id);
	if (id === undefined) return undefined;
	return {
		id,
		name: text(value.name) || `exercise-${String(id)}`,
		isOpen: booleanValue(value.isOpen ?? value.is_open, true),
		hasSolved: booleanValue(value.hasSolved ?? value.has_solved),
		...(category ? { category } : {}),
		raw: value,
	};
}

function arrayData(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (isRecord(value)) {
		for (const key of ["data", "items", "list", "corpus", "exercises"]) {
			if (Array.isArray(value[key])) return value[key];
		}
	}
	return [];
}

function normalizeDetails(value: unknown, fallback?: SlabExerciseSummary): SlabExerciseDetails {
	const record = isRecord(value) ? value : {};
	const summary = normalizeSummary(record, fallback?.category) ?? fallback;
	if (!summary) throw new SlabAgentApiError("Exercise details did not include an exercise id");
	const attachmentValue = Array.isArray(record.attachments)
		? record.attachments
		: isRecord(record.attachment)
			? Array.isArray(record.attachment.files)
				? record.attachment.files
				: [record.attachment]
			: [];
	const attachments = arrayData(attachmentValue).flatMap((item) => {
		if (!isRecord(item)) return [];
		const url = text(item.url ?? item.downloadUrl ?? item.download_url);
		if (!url) return [];
		return [
			{
				name: text(item.name) || `attachment-${String(summary.id)}`,
				url,
				...(text(item.ext) ? { ext: text(item.ext) } : {}),
			},
		];
	});
	const endpoints = Array.isArray(record.endpoints) ? record.endpoints : [];
	return {
		...summary,
		description: text(record.description ?? record.content),
		isNeedInit: booleanValue(record.isNeedInit ?? record.is_need_init),
		isNeedCheck: booleanValue(record.isNeedCheck ?? record.is_need_check),
		...(text(record.endpointType ?? record.endpoint_type)
			? { endpointType: text(record.endpointType ?? record.endpoint_type) }
			: {}),
		attachments,
		endpoints,
		raw: record,
	};
}

export class SlabAgentApi {
	private readonly base: string;
	private readonly accessKey: string;
	private readonly matchId: string;
	private readonly env: NodeJS.ProcessEnv;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly recoverAfterSubmit: boolean;

	constructor(options: SlabAgentApiOptions = {}) {
		const env = options.env ?? process.env;
		this.env = env;
		const file = parseEnvFile(
			options.competitionEnvFile ??
				env.SLAB_COMPETITION_ENV ??
				join(env.SECHEUR_CONFIG_DIR ?? ".secheur-agent", "competition.env"),
		);
		const host = options.baseUrl ?? env.SLAB_MATCH_HOST ?? file.SLAB_MATCH_HOST ?? "";
		const endpoint = host ? endpointConfig(host) : { base: "" };
		this.base = endpoint.base;
		this.accessKey = (options.accessKey ?? env.SLAB_AGENT_ACCESSKEY ?? file.SLAB_AGENT_ACCESSKEY ?? "").trim();
		this.matchId = String(
			options.matchId ?? env.SLAB_MATCH_ID ?? file.SLAB_MATCH_ID ?? endpoint.matchId ?? "",
		).trim();
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.timeoutMs = Math.max(1_000, options.timeoutMs ?? Number(env.SLAB_AGENT_TIMEOUT_MS ?? 15_000));
		this.recoverAfterSubmit = options.recoverAfterSubmit ?? true;
	}

	isConfigured(): boolean {
		return Boolean(this.base && this.accessKey);
	}

	private async request<T>(path: string, init?: RequestInit, parentSignal?: AbortSignal): Promise<T>;
	private async request<T>(
		path: string,
		init: RequestInit | undefined,
		parentSignal: AbortSignal | undefined,
		withMetadata: true,
	): Promise<{ data: T; status: number; raw: Record<string, unknown> }>;
	private async request<T>(
		path: string,
		init: RequestInit = {},
		parentSignal?: AbortSignal,
		withMetadata = false,
	): Promise<T | { data: T; status: number; raw: Record<string, unknown> }> {
		if (!this.isConfigured()) throw new SlabAgentApiError("Slab competition API is not configured");
		const request = requestSignal(parentSignal, this.timeoutMs);
		try {
			const response = await this.fetchImpl(`${this.base}${path}`, {
				...init,
				headers: {
					Accept: "application/json",
					"X-Agent-AccessKey": this.accessKey,
					...(this.matchId ? { matchId: this.matchId } : {}),
					...(init.body ? { "Content-Type": "application/json" } : {}),
					...(init.headers ?? {}),
				},
				signal: request.signal,
			});
			const body = await response.text();
			let parsed: unknown;
			try {
				parsed = body ? JSON.parse(body) : {};
			} catch {
				throw new SlabAgentApiError(
					`Slab API returned invalid JSON: ${responsePreview(body)}`,
					undefined,
					response.status,
				);
			}
			if (!response.ok) {
				throw new SlabAgentApiError(
					`Slab API request failed: HTTP ${response.status}`,
					undefined,
					response.status,
					retryAfterMs(response.headers.get("retry-after")),
					isRecord(parsed) ? parsed : undefined,
				);
			}
			if (!isRecord(parsed))
				throw new SlabAgentApiError("Slab API returned a non-object envelope", undefined, response.status);
			const envelope = parsed as SlabEnvelope;
			const code = text(envelope.code);
			if (code && code !== "00000") {
				throw new SlabAgentApiError(
					text(envelope.message) || `Slab API rejected request (${code})`,
					code,
					response.status,
					retryAfterMs(response.headers.get("retry-after")),
					isRecord(parsed) ? parsed : undefined,
				);
			}
			const data = envelope.data as T;
			return withMetadata ? { data, status: response.status, raw: isRecord(parsed) ? parsed : {} } : data;
		} catch (error) {
			if (error instanceof SlabAgentApiError) throw error;
			throw new SlabAgentApiError(
				`Slab API request failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			request.cleanup();
		}
	}

	async getMatchInfo(signal?: AbortSignal): Promise<SlabMatchInfo> {
		const data = await this.request<unknown>("/match/notice/match-info", {}, signal);
		const record = isRecord(data) ? data : {};
		return { note: text(record.note), rule: text(record.rule), raw: record };
	}

	async getOverview(signal?: AbortSignal): Promise<SlabOverview> {
		const data = await this.request<unknown>("/answer-panel/overview", {}, signal);
		const record = isRecord(data) ? data : {};
		const stagePoint = typeof record.stagePoint === "number" ? record.stagePoint : undefined;
		const stageRank = typeof record.stageRank === "number" ? record.stageRank : undefined;
		return {
			...(stagePoint === undefined ? {} : { stagePoint }),
			...(stageRank === undefined ? {} : { stageRank }),
			raw: record,
		};
	}

	async getExerciseList(signal?: AbortSignal): Promise<SlabExerciseSummary[]> {
		const data = await this.request<unknown>("/ctf/exercise-list", {}, signal);
		const items = arrayData(data);
		const direct = items.flatMap((item) => {
			// The official API wraps exercises in category records (`corpus`).
			// Those records also have ids, so only treat an item as a direct
			// exercise when it is not a category container.
			if (
				isRecord(item) &&
				(Array.isArray(item.corpus) || Array.isArray(item.exercises) || Array.isArray(item.items))
			) {
				return [];
			}
			const summary = normalizeSummary(item);
			return summary ? [summary] : [];
		});
		if (direct.length > 0) return direct;
		return items.flatMap((category) => {
			if (!isRecord(category)) return [];
			const name = text(category.name) || undefined;
			const nested = arrayData(category.corpus ?? category.exercises ?? category.items);
			return nested.flatMap((item) => {
				const summary = normalizeSummary(item, name);
				return summary ? [summary] : [];
			});
		});
	}

	async getExercise(id: SlabExerciseId, signal?: AbortSignal): Promise<SlabExerciseDetails> {
		const query = new URLSearchParams({ exerciseId: String(id) });
		return normalizeDetails(await this.request<unknown>(`/ctf/exercise?${query.toString()}`, {}, signal));
	}

	async syncExercises(signal?: AbortSignal): Promise<SlabExerciseDetails[]> {
		const summaries = await this.getExerciseList(signal);
		const pending = summaries.filter((item) => item.isOpen && !item.hasSolved);
		const batchSize = Math.min(5, Math.max(1, envInteger(this.env, "SLAB_EXERCISE_DETAIL_BATCH_SIZE", 5)));
		const batchIntervalMs = Math.max(10_000, envInteger(this.env, "SLAB_EXERCISE_DETAIL_BATCH_INTERVAL_MS", 10_000));
		const details: SlabExerciseDetails[] = [];
		for (let offset = 0; offset < pending.length; offset += batchSize) {
			if (offset > 0) await waitForSyncInterval(batchIntervalMs, signal);
			const batch = pending.slice(offset, offset + batchSize);
			for (const item of batch) details.push(await this.getExercise(item.id, signal));
		}
		return details;
	}

	async buildEnvironment(id: SlabExerciseId, signal?: AbortSignal): Promise<Record<string, unknown>> {
		return this.request<Record<string, unknown>>(
			"/ctf/build-exercise-env",
			{ method: "POST", body: JSON.stringify({ exerciseId: id }) },
			signal,
		);
	}

	async recoverEnvironment(id: SlabExerciseId, signal?: AbortSignal): Promise<Record<string, unknown>> {
		return this.request<Record<string, unknown>>(
			"/ctf/recover-exercise-env",
			{ method: "POST", body: JSON.stringify({ exerciseId: id }) },
			signal,
		);
	}

	async waitForReady(id: SlabExerciseId, signal?: AbortSignal): Promise<SlabExerciseDetails> {
		const attempts = Math.max(1, Number(this.env.SLAB_ENV_POLL_ATTEMPTS ?? 60));
		const delayMs = Math.max(500, Number(this.env.SLAB_ENV_POLL_INTERVAL_MS ?? 5_000));
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			const details = await this.getExercise(id, signal);
			if (!details.isNeedCheck && details.endpoints.length > 0) return details;
			if (attempt + 1 < attempts) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		}
		throw new SlabAgentApiError(`Environment for exercise ${String(id)} did not become ready`);
	}

	async submitFlag(id: SlabExerciseId, flag: string, signal?: AbortSignal): Promise<SlabAnswerResult> {
		const result = await this.request<unknown>(
			"/answer-panel/answer",
			{ method: "POST", body: JSON.stringify({ exerciseId: id, flag }) },
			signal,
			true,
		);
		const data = isRecord(result.data) ? result.data : {};
		const record = isRecord(data) ? data : {};
		const correct = booleanValue(record.isCorrect ?? record.correct);
		if (correct && this.recoverAfterSubmit) {
			try {
				await this.recoverEnvironment(id, signal);
			} catch {
				// A correct answer remains a solved result even if cleanup is temporarily unavailable.
			}
		}
		return {
			correct,
			data: record,
			httpStatus: result.status,
			businessCode: text(record.code ?? record.result_code ?? record.resultCode) || undefined,
			status: text(record.status ?? record.result),
			rawResponse: result.raw,
		};
	}
}

export function normalizeCompetitionFlag(value: string): string {
	const trimmed = value
		.trim()
		.replace(/^```(?:text)?\s*/iu, "")
		.replace(/\s*```$/u, "")
		.trim();
	const wrapped = trimmed.match(/^(?:DASCTF|flag)\{(.+)\}$/iu);
	if (wrapped?.[1]) return wrapped[1];
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed.slice(1, -1);
	return trimmed;
}

export function competitionEnvPath(config: SecHeurConfig, env: NodeJS.ProcessEnv = process.env): string {
	return env.SLAB_COMPETITION_ENV?.trim() || join(config.stateDir, "competition.env");
}
