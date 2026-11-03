import {
	type SlabAgentApi,
	SlabAgentApiError,
	type SlabExerciseDetails,
	type SlabExerciseId,
	type SlabExerciseSummary,
} from "./competition-api.ts";
import {
	type ArtifactRef,
	type ChallengeSnapshot,
	type EnvironmentAccess,
	type FlagFormat,
	formatFlagCandidate,
	type ScoreSnapshot,
	type SubmissionPolicy,
} from "./competition-protocol.ts";

export interface CompetitionPolicy {
	flagFormat: FlagFormat;
	submission: SubmissionPolicy;
	maxEnvironmentSlots: number;
	raw: Record<string, unknown>;
}

export interface CompetitionChallengeSummary {
	exerciseId: string | number;
	name: string;
	category: string;
	isOpen: boolean;
	hasSolved: boolean;
	score: number;
	difficulty?: number;
	raw: Record<string, unknown>;
}

export interface CompetitionChallenge extends ChallengeSnapshot {
	isOpen: boolean;
	hasSolved: boolean;
}

export interface EnvironmentStartResult {
	status: "pending" | "ready" | "blocked";
	endpoints: unknown[];
	leaseMetadata: Record<string, unknown>;
	raw: Record<string, unknown>;
}

export interface CompetitionSubmitResult {
	isCorrect: boolean;
	status?: string;
	message?: string;
	httpStatus?: number;
	businessCode?: string;
	requestPayload: Record<string, unknown>;
	rawResponse: Record<string, unknown>;
	retryAfterMs?: number;
}

export interface CompetitionPlatformAdapter {
	readonly platform: string;
	getPolicy(signal?: AbortSignal): Promise<CompetitionPolicy>;
	listChallenges(signal?: AbortSignal): Promise<CompetitionChallengeSummary[]>;
	getChallenge(exerciseId: string | number, signal?: AbortSignal): Promise<CompetitionChallenge>;
	startEnvironment(exerciseId: string | number, signal?: AbortSignal): Promise<EnvironmentStartResult>;
	getEnvironment(exerciseId: string | number, signal?: AbortSignal): Promise<EnvironmentStartResult>;
	heartbeatEnvironment?(exerciseId: string | number, signal?: AbortSignal): Promise<EnvironmentStartResult>;
	submitFlag(
		exerciseId: string | number,
		flag: string,
		context: { taskId: string; attemptNo: number; policy: CompetitionPolicy },
		signal?: AbortSignal,
	): Promise<CompetitionSubmitResult>;
	releaseEnvironment(exerciseId: string | number, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export class CompetitionPlatformError extends Error {
	readonly code?: string;
	readonly httpStatus?: number;
	readonly retryAfterMs?: number;
	readonly category: "rate_limited" | "environment_error" | "platform_closed" | "request_error";
	readonly rawResponse?: Record<string, unknown>;

	constructor(
		message: string,
		options: {
			code?: string;
			httpStatus?: number;
			retryAfterMs?: number;
			category?: CompetitionPlatformError["category"];
			rawResponse?: Record<string, unknown>;
		} = {},
	) {
		super(message);
		this.name = "CompetitionPlatformError";
		this.code = options.code;
		this.httpStatus = options.httpStatus;
		this.retryAfterMs = options.retryAfterMs;
		this.category = options.category ?? classifyPlatformFailure(options.httpStatus, options.code);
		this.rawResponse = options.rawResponse;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function bool(value: unknown, fallback = false): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") return !["", "0", "false", "no", "off"].includes(value.toLowerCase());
	return fallback;
}

function number(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function array(value: unknown): unknown[] {
	if (Array.isArray(value)) return [...value];
	if (isRecord(value)) {
		for (const key of ["data", "items", "list", "challenges", "exercises", "endpoints"]) {
			if (Array.isArray(value[key])) return [...value[key]];
		}
	}
	return [];
}

function record(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function id(value: unknown): string | number {
	if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	if (typeof value === "string" && value.trim())
		return /^\d+$/u.test(value.trim()) ? Number(value.trim()) : value.trim();
	throw new CompetitionPlatformError("Challenge response did not include an id", { category: "request_error" });
}

function endpoints(value: unknown): unknown[] {
	return array(value);
}

function absoluteUrl(value: string, baseUrl: string): string {
	try {
		return new URL(value, `${baseUrl}/`).toString();
	} catch {
		return value;
	}
}

function attachmentName(value: string): string {
	try {
		const pathname = new URL(value, "http://localhost").pathname;
		const name = pathname.split("/").filter(Boolean).at(-1);
		return name || "attachment";
	} catch {
		return value.split("/").filter(Boolean).at(-1) || "attachment";
	}
}

function ctfdAgentMetadata(raw: Record<string, unknown>): Record<string, unknown> {
	const metadata: Record<string, unknown> = {};
	const scalarFields: Array<[string, unknown]> = [
		["id", raw.id ?? raw.challenge_id],
		["name", raw.name],
		["category", raw.category],
		["type", raw.type],
		["function", raw.function],
		["state", raw.state],
		["value", raw.value ?? raw.points],
		["difficulty", raw.difficulty],
		["maxAttempts", raw.maxAttempts ?? raw.max_attempts],
		["solved", raw.solved ?? raw.solved_by_me ?? raw.solvedByMe],
	];
	for (const [key, value] of scalarFields) {
		if (typeof value === "string" && value.trim()) metadata[key] = value.trim();
		else if (typeof value === "number" && Number.isFinite(value)) metadata[key] = value;
		else if (typeof value === "boolean") metadata[key] = value;
	}
	for (const key of ["tags", "topics"]) {
		const values = array(raw[key]).filter(
			(value): value is string => typeof value === "string" && value.trim().length > 0,
		);
		if (values.length > 0) metadata[key] = values;
	}
	return metadata;
}

export function flagFormatFromRaw(raw: Record<string, unknown>, fallback: FlagFormat): FlagFormat {
	const format = record(raw.flagFormat ?? raw.flag_format ?? raw.answerFormat ?? raw.answer_format);
	const stringOrFallback = (value: unknown, fallbackValue: string): string =>
		typeof value === "string" ? value.trim() : fallbackValue;
	const prefix = stringOrFallback(format.prefix ?? raw.flagPrefix ?? raw.flag_prefix, fallback.prefix);
	const suffix = stringOrFallback(format.suffix ?? raw.flagSuffix ?? raw.flag_suffix, fallback.suffix);
	const accepts =
		format.accepts === "full" || format.accepts === "inner" || format.accepts === "either"
			? format.accepts
			: fallback.accepts;
	const submit = format.submit === "full" || format.submit === "inner" ? format.submit : fallback.submit;
	const pattern = text(format.pattern ?? raw.flagPattern ?? raw.flag_pattern);
	const maxLength = number(format.maxLength ?? raw.flagMaxLength ?? raw.flag_max_length, 0);
	return {
		prefix,
		suffix,
		accepts,
		submit,
		...(pattern ? { pattern } : {}),
		...(maxLength > 0 ? { maxLength: Math.trunc(maxLength) } : {}),
	};
}

function scoreFromRaw(raw: Record<string, unknown>, now: number): ScoreSnapshot {
	const score = record(raw.scoring ?? raw.score);
	return {
		currentScore: number(score.currentScore ?? score.current_score ?? raw.currentScore ?? raw.current_score, 0),
		challengeValue: number(score.challengeValue ?? score.challenge_value ?? raw.value ?? raw.points, 0),
		...(score.difficulty === undefined && raw.difficulty === undefined
			? {}
			: { difficulty: number(score.difficulty ?? raw.difficulty, 0) }),
		estimatedSolveProbability: Math.min(
			1,
			Math.max(0, number(score.estimatedSolveProbability ?? score.probability, 0.2)),
		),
		confidence: Math.min(1, Math.max(0, number(score.confidence, 0))),
		expectedRemainingMinutes: Math.max(0, number(score.expectedRemainingMinutes ?? score.remainingMinutes, 30)),
		environmentWaitMinutes: Math.max(0, number(score.environmentWaitMinutes ?? score.waitMinutes, 0)),
		agingBonus: Math.max(0, number(score.agingBonus, 0)),
		asOf: now,
	};
}

function artifactRefs(details: SlabExerciseDetails): ArtifactRef[] {
	return details.attachments.map((attachment) => ({ name: attachment.name, url: attachment.url }));
}

function slabChallenge(details: SlabExerciseDetails, policy: CompetitionPolicy): CompetitionChallenge {
	const now = Date.now();
	const raw = details.raw;
	const format = flagFormatFromRaw(raw, policy.flagFormat);
	const environment: EnvironmentAccess = {
		required:
			details.isNeedInit ||
			details.isNeedCheck ||
			details.endpoints.length > 0 ||
			Boolean(details.endpointType && details.endpointType !== "none"),
		status: details.endpoints.length > 0 && !details.isNeedCheck ? "ready" : "pending",
		endpoints: details.endpoints,
	};
	return {
		exerciseId: details.id,
		name: details.name,
		category: details.category ?? "unknown",
		description: details.description,
		hints: Array.isArray(raw.hints) ? raw.hints.filter((hint): hint is string => typeof hint === "string") : [],
		flagFormat: format,
		attachments: artifactRefs(details),
		environment,
		scoring: scoreFromRaw(raw, now),
		platform: raw,
		isOpen: details.isOpen,
		hasSolved: details.hasSolved,
	};
}

function classifyPlatformFailure(status?: number, code?: string): CompetitionPlatformError["category"] {
	if (status === 429 || code === "429") return "rate_limited";
	if (
		status === 404 ||
		status === 401 ||
		status === 403 ||
		code === "40403" ||
		/closed|forbidden|expired/iu.test(code ?? "")
	)
		return "platform_closed";
	if (status === 550 || code === "550" || /environment|quota|slot|machine/iu.test(code ?? ""))
		return "environment_error";
	return "request_error";
}

function retryAfterMs(value: unknown): number | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value * 1000));
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, Math.trunc(seconds * 1000));
	const date = Date.parse(String(value));
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function slabError(error: unknown): CompetitionPlatformError {
	if (error instanceof CompetitionPlatformError) return error;
	if (error instanceof SlabAgentApiError) {
		return new CompetitionPlatformError(error.message, {
			code: error.code,
			httpStatus: error.status,
			retryAfterMs: error.retryAfterMs,
			category: classifyPlatformFailure(error.status, error.code),
			rawResponse: error.response,
		});
	}
	return new CompetitionPlatformError(error instanceof Error ? error.message : String(error));
}

export interface SlabCompetitionAdapterOptions {
	api: SlabAgentApi;
	platform?: string;
	flagFormat?: Partial<FlagFormat>;
	maxEnvironmentSlots?: number;
	submitMode?: "full" | "inner";
}

export class SlabCompetitionAdapter implements CompetitionPlatformAdapter {
	readonly platform: string;
	private readonly api: SlabAgentApi;
	private readonly defaultFormat: FlagFormat;
	private readonly maxEnvironmentSlots: number;

	constructor(options: SlabCompetitionAdapterOptions) {
		this.platform = options.platform ?? "slab";
		this.api = options.api;
		this.defaultFormat = {
			prefix: options.flagFormat?.prefix ?? "DASCTF{",
			suffix: options.flagFormat?.suffix ?? "}",
			accepts: options.flagFormat?.accepts ?? "either",
			submit: options.submitMode ?? options.flagFormat?.submit ?? "inner",
			...(options.flagFormat?.pattern ? { pattern: options.flagFormat.pattern } : {}),
			...(options.flagFormat?.maxLength ? { maxLength: options.flagFormat.maxLength } : {}),
		};
		this.maxEnvironmentSlots = Math.max(1, Math.trunc(options.maxEnvironmentSlots ?? 3));
	}

	async getPolicy(signal?: AbortSignal): Promise<CompetitionPolicy> {
		try {
			const info = await this.api.getMatchInfo(signal);
			const flagFormat = flagFormatFromRaw(info.raw, this.defaultFormat);
			const maxAttempts = Math.max(1, Math.trunc(number(info.raw.maxAttempts ?? info.raw.max_attempts, 3)));
			return {
				flagFormat,
				submission: {
					flagFormat,
					maxAttempts,
					duplicateScope: "challenge",
					acceptedStatuses: ["correct", "accepted"],
				},
				maxEnvironmentSlots: this.maxEnvironmentSlots,
				raw: info.raw,
			};
		} catch (error) {
			throw slabError(error);
		}
	}

	async listChallenges(signal?: AbortSignal): Promise<CompetitionChallengeSummary[]> {
		try {
			return (await this.api.getExerciseList(signal)).map((item: SlabExerciseSummary) => ({
				exerciseId: item.id,
				name: item.name,
				category: item.category ?? "unknown",
				isOpen: item.isOpen,
				hasSolved: item.hasSolved,
				score: number(item.raw.score ?? item.raw.value ?? item.raw.points, 0),
				difficulty: typeof item.raw.difficulty === "number" ? item.raw.difficulty : undefined,
				raw: item.raw,
			}));
		} catch (error) {
			throw slabError(error);
		}
	}

	async getChallenge(exerciseId: string | number, signal?: AbortSignal): Promise<CompetitionChallenge> {
		try {
			return slabChallenge(
				await this.api.getExercise(exerciseId as SlabExerciseId, signal),
				await this.getPolicy(signal),
			);
		} catch (error) {
			throw slabError(error);
		}
	}

	async startEnvironment(exerciseId: string | number, signal?: AbortSignal): Promise<EnvironmentStartResult> {
		try {
			const raw = await this.api.buildEnvironment(exerciseId as SlabExerciseId, signal);
			return { status: "pending", endpoints: [], leaseMetadata: raw, raw };
		} catch (error) {
			throw slabError(error);
		}
	}

	async getEnvironment(exerciseId: string | number, signal?: AbortSignal): Promise<EnvironmentStartResult> {
		try {
			const details = await this.api.waitForReady(exerciseId as SlabExerciseId, signal);
			return {
				status: "ready",
				endpoints: details.endpoints,
				leaseMetadata: { exerciseId },
				raw: details.raw,
			};
		} catch (error) {
			throw slabError(error);
		}
	}

	async submitFlag(
		exerciseId: string | number,
		flag: string,
		_context: { taskId: string; attemptNo: number; policy: CompetitionPolicy },
		signal?: AbortSignal,
	): Promise<CompetitionSubmitResult> {
		const requestPayload = { exerciseId, flag };
		try {
			const result = await this.api.submitFlag(exerciseId as SlabExerciseId, flag, signal);
			return {
				isCorrect: result.correct,
				status: result.status || (result.correct ? "accepted" : "incorrect"),
				httpStatus: result.httpStatus,
				businessCode: result.businessCode,
				requestPayload,
				rawResponse: result.rawResponse ?? result.data,
			};
		} catch (error) {
			throw slabError(error);
		}
	}

	async releaseEnvironment(exerciseId: string | number, signal?: AbortSignal): Promise<Record<string, unknown>> {
		try {
			return await this.api.recoverEnvironment(exerciseId as SlabExerciseId, signal);
		} catch (error) {
			throw slabError(error);
		}
	}
}

export interface CtfLabAdapterOptions {
	baseUrl: string;
	token: string;
	authScheme?: "Token" | "Bearer";
	environmentGatewayUrl?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	maxEnvironmentSlots?: number;
	flagFormat?: Partial<FlagFormat>;
}

export class CtfLabAdapter implements CompetitionPlatformAdapter {
	readonly platform = "ctfd";
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly authScheme: string;
	private readonly gatewayUrl?: string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly maxEnvironmentSlots: number;
	private readonly defaultFormat: FlagFormat;

	constructor(options: CtfLabAdapterOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
		this.token = options.token;
		this.authScheme = options.authScheme ?? "Token";
		this.gatewayUrl = options.environmentGatewayUrl?.replace(/\/+$/u, "");
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.timeoutMs = Math.max(1_000, Math.trunc(options.timeoutMs ?? 15_000));
		this.maxEnvironmentSlots = Math.max(1, Math.trunc(options.maxEnvironmentSlots ?? 3));
		this.defaultFormat = {
			prefix: options.flagFormat?.prefix ?? "",
			suffix: options.flagFormat?.suffix ?? "",
			accepts: options.flagFormat?.accepts ?? "either",
			submit: options.flagFormat?.submit ?? "full",
			...(options.flagFormat?.pattern ? { pattern: options.flagFormat.pattern } : {}),
			...(options.flagFormat?.maxLength ? { maxLength: options.flagFormat.maxLength } : {}),
		};
	}

	private async request<T>(path: string, init?: RequestInit, signal?: AbortSignal, gateway?: boolean): Promise<T>;
	private async request<T>(
		path: string,
		init: RequestInit | undefined,
		signal: AbortSignal | undefined,
		gateway: boolean,
		withMetadata: true,
	): Promise<{ data: T; status: number; raw: Record<string, unknown> }>;
	private async request<T>(
		path: string,
		init: RequestInit = {},
		signal?: AbortSignal,
		gateway = false,
		withMetadata = false,
	): Promise<T | { data: T; status: number; raw: Record<string, unknown> }> {
		const base = gateway ? this.gatewayUrl : this.baseUrl;
		if (!base)
			throw new CompetitionPlatformError("CTF lab environment gateway is not configured", {
				category: "environment_error",
			});
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		const onAbort = (): void => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const response = await this.fetchImpl(`${base}${path}`, {
				...init,
				headers: {
					Accept: "application/json",
					...(gateway
						? {}
						: {
								...(this.token ? { Authorization: `${this.authScheme} ${this.token}` } : {}),
								...(this.token ? { "Content-Type": "application/json" } : {}),
							}),
					...(init.body ? { "Content-Type": "application/json" } : {}),
					...(init.headers ?? {}),
				},
				signal: controller.signal,
			});
			const body = await response.text();
			let parsed: unknown = {};
			try {
				parsed = body ? JSON.parse(body) : {};
			} catch {
				if (response.ok && !response.headers.get("content-type")?.includes("json")) parsed = {};
				else
					throw new CompetitionPlatformError(`CTFd returned invalid JSON: ${body.slice(0, 300)}`, {
						httpStatus: response.status,
					});
			}
			if (!response.ok) {
				const responseRecord = record(parsed);
				throw new CompetitionPlatformError(
					text(responseRecord.message, `CTFd request failed: HTTP ${response.status}`),
					{
						httpStatus: response.status,
						code: text(responseRecord.code),
						retryAfterMs: retryAfterMs(response.headers.get("retry-after") ?? undefined),
						...(gateway ? { category: "environment_error" as const } : {}),
						rawResponse: responseRecord,
					},
				);
			}
			const data = (isRecord(parsed) && "data" in parsed ? parsed.data : parsed) as T;
			return withMetadata ? { data, status: response.status, raw: isRecord(parsed) ? parsed : {} } : data;
		} catch (error) {
			if (error instanceof CompetitionPlatformError) throw error;
			throw new CompetitionPlatformError(error instanceof Error ? error.message : String(error), {
				category: gateway ? "environment_error" : "request_error",
			});
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async getPolicy(signal?: AbortSignal): Promise<CompetitionPolicy> {
		let raw: Record<string, unknown> = {};
		try {
			raw = record(await this.request<unknown>("/api/v1/configs", {}, signal));
		} catch (error) {
			if (!(error instanceof CompetitionPlatformError) || error.httpStatus !== 404) throw error;
		}
		const flagFormat = flagFormatFromRaw(raw, this.defaultFormat);
		const maxAttempts = Math.max(1, Math.trunc(number(raw.maxAttempts ?? raw.max_attempts, 3)));
		return {
			flagFormat,
			submission: {
				flagFormat,
				maxAttempts,
				duplicateScope: "challenge",
				acceptedStatuses: ["correct", "already_solved"],
			},
			maxEnvironmentSlots: this.maxEnvironmentSlots,
			raw: { maxAttempts, flagFormat },
		};
	}

	async listChallenges(signal?: AbortSignal): Promise<CompetitionChallengeSummary[]> {
		const data = array(await this.request<unknown>("/api/v1/challenges", {}, signal));
		return data.flatMap((value) => {
			const raw = record(value);
			try {
				return [
					{
						exerciseId: id(raw.id ?? raw.challenge_id),
						name: text(raw.name, "challenge"),
						category: text(raw.category, "unknown"),
						isOpen: !bool(raw.state === "hidden" || raw.state === "closed"),
						hasSolved: bool(raw.solved ?? raw.solved_by_me ?? raw.solvedByMe),
						score: number(raw.value ?? raw.points, 0),
						difficulty: typeof raw.difficulty === "number" ? raw.difficulty : undefined,
						raw: ctfdAgentMetadata(raw),
					},
				];
			} catch {
				return [];
			}
		});
	}

	async getChallenge(exerciseId: string | number, signal?: AbortSignal): Promise<CompetitionChallenge> {
		const raw = record(
			await this.request<unknown>(`/api/v1/challenges/${encodeURIComponent(String(exerciseId))}`, {}, signal),
		);
		const format = flagFormatFromRaw(raw, this.defaultFormat);
		const environmentRaw = raw.connection_info ?? raw.connectionInfo;
		const requiresGatewayLease = Boolean(this.gatewayUrl) && environmentRaw !== undefined;
		const environment: EnvironmentAccess = {
			required: requiresGatewayLease,
			status: requiresGatewayLease ? "pending" : environmentRaw ? "ready" : "none",
			endpoints: requiresGatewayLease ? [] : environmentRaw ? [environmentRaw] : [],
		};
		return {
			exerciseId: id(raw.id ?? raw.challenge_id ?? exerciseId),
			name: text(raw.name, `challenge-${String(exerciseId)}`),
			category: text(raw.category, "unknown"),
			description: text(raw.description ?? raw.content),
			hints: array(raw.hints).filter((hint): hint is string => typeof hint === "string"),
			flagFormat: format,
			attachments: array(raw.files ?? raw.attachments).flatMap((value) => {
				if (typeof value === "string" && value.trim()) {
					const url = absoluteUrl(value.trim(), this.baseUrl);
					return [{ name: attachmentName(value.trim()), url }];
				}
				const item = record(value);
				const rawUrl = text(item.url ?? item.download_url ?? item.downloadUrl);
				if (!rawUrl) return [];
				const url = absoluteUrl(rawUrl, this.baseUrl);
				return [
					{
						name: text(item.name, attachmentName(rawUrl)),
						url,
						...(typeof item.sha256 === "string" ? { sha256: item.sha256 } : {}),
						...(typeof item.size === "number" ? { sizeBytes: item.size } : {}),
					},
				];
			}),
			environment,
			scoring: scoreFromRaw(raw, Date.now()),
			platform: ctfdAgentMetadata(raw),
			isOpen: raw.state !== "hidden" && raw.state !== "closed",
			hasSolved: bool(raw.solved ?? raw.solved_by_me ?? raw.solvedByMe),
		};
	}

	async startEnvironment(exerciseId: string | number, signal?: AbortSignal): Promise<EnvironmentStartResult> {
		const raw = record(
			await this.request<unknown>(
				"/v1/environments",
				{ method: "POST", body: JSON.stringify({ exerciseId: String(exerciseId) }) },
				signal,
				true,
			),
		);
		const environmentEndpoints = endpoints(raw.endpoints ?? raw.endpoint ?? raw.connection_info);
		return {
			status: environmentEndpoints.length > 0 ? "ready" : "pending",
			endpoints: environmentEndpoints,
			leaseMetadata: raw,
			raw,
		};
	}

	async getEnvironment(exerciseId: string | number, signal?: AbortSignal): Promise<EnvironmentStartResult> {
		const raw = record(
			await this.request<unknown>(`/v1/environments/${encodeURIComponent(String(exerciseId))}`, {}, signal, true),
		);
		const environmentEndpoints = endpoints(raw.endpoints ?? raw.endpoint ?? raw.connection_info);
		const status = text(raw.status, environmentEndpoints.length > 0 ? "ready" : "pending");
		return {
			status:
				status === "blocked"
					? "blocked"
					: environmentEndpoints.length > 0 || status === "ready"
						? "ready"
						: "pending",
			endpoints: environmentEndpoints,
			leaseMetadata: raw,
			raw,
		};
	}

	async heartbeatEnvironment(exerciseId: string | number, signal?: AbortSignal): Promise<EnvironmentStartResult> {
		const raw = record(
			await this.request<unknown>(
				`/v1/environments/${encodeURIComponent(String(exerciseId))}/heartbeat`,
				{ method: "POST" },
				signal,
				true,
			),
		);
		const environmentEndpoints = endpoints(raw.endpoints ?? raw.endpoint ?? raw.connection_info);
		return {
			status: environmentEndpoints.length > 0 ? "ready" : "pending",
			endpoints: environmentEndpoints,
			leaseMetadata: raw,
			raw,
		};
	}

	async submitFlag(
		exerciseId: string | number,
		flag: string,
		_context: { taskId: string; attemptNo: number; policy: CompetitionPolicy },
		signal?: AbortSignal,
	): Promise<CompetitionSubmitResult> {
		const requestPayload = { challenge_id: exerciseId, submission: flag };
		const result = await this.request<unknown>(
			`/api/v1/challenges/attempt`,
			{ method: "POST", body: JSON.stringify({ challenge_id: exerciseId, submission: flag }) },
			signal,
			false,
			true,
		);
		const raw = record(result.data);
		const status = text(raw.status ?? raw.result);
		return {
			isCorrect: status === "correct" || status === "already_solved" || raw.success === true,
			status,
			message: text(raw.message),
			businessCode: text(raw.code ?? raw.result_code ?? raw.resultCode) || undefined,
			httpStatus: result.status,
			requestPayload,
			rawResponse: result.raw,
		};
	}

	async releaseEnvironment(exerciseId: string | number, signal?: AbortSignal): Promise<Record<string, unknown>> {
		if (!this.gatewayUrl) return { exerciseId, released: false, reason: "gateway_not_configured" };
		return record(
			await this.request<unknown>(
				`/v1/environments/${encodeURIComponent(String(exerciseId))}`,
				{ method: "DELETE" },
				signal,
				true,
			),
		);
	}
}

export function validateSubmissionFlag(
	candidate: string,
	policy: CompetitionPolicy,
): { normalized: string; submitted: string } {
	return formatFlagCandidate(candidate, policy.flagFormat);
}
