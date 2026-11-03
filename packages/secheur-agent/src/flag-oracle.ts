import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_ORACLE_URL = "http://127.0.0.1:18181";
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_VERIFY_REQUEST_BYTES = 8_192;
const DEFAULT_VERIFY_AGENT_ID = "secheur-pi";
const PROCESS_RUN_ID = `run-${randomUUID().replace(/-/gu, "").slice(0, 16)}`;
const DEFAULT_VERIFY_RUN_ID = PROCESS_RUN_ID;

export class FlagOracleError extends Error {}
export class FlagOracleConfigurationError extends FlagOracleError {}
export class FlagOracleUnavailableError extends FlagOracleError {}
export class FlagOracleProtocolError extends FlagOracleError {}
export class FlagOracleTimeoutError extends FlagOracleError {}
export class FlagOracleAbortedError extends FlagOracleError {}

export type FlagOracleVerificationOutcome = "correct" | "incorrect" | "infra_error";

/**
 * These are terminal verifier-budget responses, not candidate feedback.
 * They are deliberately kept narrower than generic rate-limit or transport
 * failures: only the Oracle/Proxy statuses below prove that this run can no
 * longer spend another verification attempt.
 */
export const FLAG_ORACLE_QUOTA_EXHAUSTED_STATUSES = ["attempt_limit_reached", "limit_exceeded"] as const;

export function isFlagOracleQuotaExhaustedStatus(status: unknown): boolean {
	return typeof status === "string" && (FLAG_ORACLE_QUOTA_EXHAUSTED_STATUSES as readonly string[]).includes(status);
}

export interface FlagOracleVerifyInput {
	flag: string;
	challengeId?: string;
	agentId?: string;
	runId?: string;
}

export interface FlagOracleVerifyResult {
	ok: boolean;
	status: string;
	verified: boolean;
	correct: boolean;
	verificationOutcome: FlagOracleVerificationOutcome;
	failureCategory?: string;
	[key: string]: unknown;
}

interface FlagOracleConfig {
	baseUrl: string;
	token: string;
	socketPath: string;
	timeoutMs: number;
}

function parseEnvFile(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return {};
	}
	const allowed = new Set([
		"CTF_ORACLE_URL",
		"CTF_ORACLE_TOKEN",
		"CTF_ORACLE_SOCKET",
		"CTF_AGENT_ID",
		"CTF_RUN_ID",
		"FLAG_ORACLE_AGENT_ID",
		"FLAG_ORACLE_RUN_ID",
		"SECHEUR_RUN_ID",
		"SECHEUR_TARGET_ID",
		"CTF_TARGET_ID",
		"TARGET_ID",
		"SECHEUR_CHALLENGE_ID",
	]);
	const result: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || !line.includes("=")) continue;
		const separator = line.indexOf("=");
		const key = line.slice(0, separator).trim();
		if (!allowed.has(key)) continue;
		let value = line.slice(separator + 1).trim();
		if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
			value = value.slice(1, -1);
		}
		result[key] = value;
	}
	return result;
}

export function flagOracleConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	const envPath =
		env.CTF_ORACLE_CLIENT_ENV_FILE?.trim() || join(homedir(), ".config", "secheur-agent", "oracle-client.env");
	const file = parseEnvFile(envPath);
	return Boolean(
		env.CTF_ORACLE_SOCKET?.trim() ||
			env.CTF_ORACLE_TOKEN?.trim() ||
			file.CTF_ORACLE_SOCKET?.trim() ||
			file.CTF_ORACLE_TOKEN?.trim(),
	);
}

function loadConfig(env: NodeJS.ProcessEnv): FlagOracleConfig {
	const envPath =
		env.CTF_ORACLE_CLIENT_ENV_FILE?.trim() || join(homedir(), ".config", "secheur-agent", "oracle-client.env");
	const file = parseEnvFile(envPath);
	const baseUrl = (env.CTF_ORACLE_URL || file.CTF_ORACLE_URL || DEFAULT_ORACLE_URL).trim().replace(/\/+$/u, "");
	const socketPath = (env.CTF_ORACLE_SOCKET || file.CTF_ORACLE_SOCKET || "").trim();
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(baseUrl);
	} catch {
		throw new FlagOracleConfigurationError("CTF_ORACLE_URL is not a valid URL");
	}
	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
		throw new FlagOracleConfigurationError("CTF_ORACLE_URL must use HTTP or HTTPS");
	}
	const token = (env.CTF_ORACLE_TOKEN || file.CTF_ORACLE_TOKEN || "").trim();
	if (!socketPath && !token) {
		throw new FlagOracleConfigurationError("CTF_ORACLE_TOKEN or CTF_ORACLE_SOCKET is not configured");
	}
	const timeoutSeconds = Number(env.CTF_ORACLE_TIMEOUT ?? "");
	return {
		baseUrl,
		token,
		socketPath,
		timeoutMs: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds * 1000 : 8_000,
	};
}

async function responseBytes(response: Response): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const item = await reader.read();
			if (item.done) break;
			total += item.value.byteLength;
			if (total > MAX_RESPONSE_BYTES) {
				const error = new FlagOracleError("Flag Oracle response exceeded 1000000 bytes");
				try {
					await reader.cancel(error);
				} catch {
					// 响应大小错误比底层流的取消错误更有用。
				}
				throw error;
			}
			chunks.push(item.value);
		}
	} finally {
		reader.releaseLock();
	}
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

function decodeObject(bytes: Uint8Array): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch (error) {
		throw new FlagOracleProtocolError(
			`Flag Oracle returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new FlagOracleProtocolError("Flag Oracle returned a non-object JSON response");
	}
	return parsed as Record<string, unknown>;
}

function errorDetail(bytes: Uint8Array): string {
	if (bytes.byteLength === 0) return "";
	const text = new TextDecoder().decode(bytes);
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const object = parsed as Record<string, unknown>;
			return String(object.error ?? object.message ?? "").slice(0, 500);
		}
	} catch {
		return text.slice(0, 500);
	}
	return text.slice(0, 500);
}

interface RequestOptions {
	method?: "GET" | "POST";
	body?: Record<string, unknown>;
	signal?: AbortSignal;
}

function combinedTimeoutSignal(
	signal: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error("Flag Oracle request timed out"));
	}, timeoutMs);
	timer.unref();
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		timedOut: () => timedOut,
		cleanup: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

async function request(env: NodeJS.ProcessEnv, path: string, options: RequestOptions = {}): Promise<Record<string, unknown>> {
	const config = loadConfig(env);
	if (!config.token) throw new FlagOracleConfigurationError("CTF_ORACLE_TOKEN is not configured");
	const requestSignal = combinedTimeoutSignal(options.signal, config.timeoutMs);
	let response: Response;
	try {
		response = await fetch(`${config.baseUrl}${path}`, {
			method: options.method ?? "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${config.token}`,
				...(options.body ? { "Content-Type": "application/json" } : {}),
			},
			...(options.body ? { body: JSON.stringify(options.body) } : {}),
			signal: requestSignal.signal,
		});
	} catch (error) {
		requestSignal.cleanup();
		if (options.signal?.aborted) {
			throw new FlagOracleAbortedError("Flag Oracle verification aborted");
		}
		if (requestSignal.timedOut()) throw new FlagOracleTimeoutError("Flag Oracle request timed out");
		throw new FlagOracleUnavailableError(
			`Flag Oracle is unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		const bytes = await responseBytes(response);
		if (!response.ok) {
			const detail = errorDetail(bytes);
			if (response.status === 401 || response.status === 403) {
				throw new FlagOracleConfigurationError(
					`Flag Oracle authentication failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`,
				);
			}
			throw new FlagOracleUnavailableError(
				`Flag Oracle request failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`,
			);
		}
		return decodeObject(bytes);
	} catch (error) {
		if (error instanceof FlagOracleError) throw error;
		if (options.signal?.aborted) throw new FlagOracleAbortedError("Flag Oracle verification aborted");
		if (requestSignal.timedOut()) throw new FlagOracleTimeoutError("Flag Oracle request timed out");
		throw new FlagOracleUnavailableError(
			`Flag Oracle is unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		requestSignal.cleanup();
	}
}

function resolveEnvValue(env: NodeJS.ProcessEnv, file: Record<string, string>, keys: readonly string[], fallback: string): string {
	for (const key of keys) {
		const value = (env[key] || file[key] || "").trim();
		if (value) return value;
	}
	return fallback;
}

function verifyResponsePayload(response: Record<string, unknown>): Record<string, unknown> {
	if (isRecord(response.result) && response.status === undefined && response.verified === undefined) {
		return response.result;
	}
	return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeVerifyResponse(response: Record<string, unknown>, challengeId: string): FlagOracleVerifyResult {
	const payload = verifyResponsePayload(response);
	const status = typeof payload.status === "string" ? payload.status : "";
	const serverOk = payload.ok === true;
	const serverVerified = payload.verified === true || payload.correct === true;
	const statusCorrect = status === "correct";
	const statusIncorrect = status === "incorrect" || status === "duplicate";
	if (statusCorrect && (!serverOk || !serverVerified)) {
		return {
			...payload,
			ok: false,
			status: "protocol_error",
			verified: false,
			correct: false,
			verificationOutcome: "infra_error",
			failureCategory: "protocol_error",
			challenge_id: payload.challenge_id ?? challengeId,
		};
	}
	if (statusCorrect) {
		return {
			...payload,
			ok: true,
			status: "correct",
			verified: true,
			correct: true,
			verificationOutcome: "correct",
			challenge_id: payload.challenge_id ?? challengeId,
		};
	}
	if (statusIncorrect) {
		return {
			...payload,
			ok: true,
			status,
			verified: false,
			correct: false,
			verificationOutcome: "incorrect",
			challenge_id: payload.challenge_id ?? challengeId,
		};
	}
	if (isFlagOracleQuotaExhaustedStatus(status)) {
		return {
			...payload,
			ok: false,
			status,
			verified: false,
			correct: false,
			verificationOutcome: "infra_error",
			failureCategory: "quota_exhausted",
			challenge_id: payload.challenge_id ?? challengeId,
		};
	}
	return {
		...payload,
		ok: false,
		status: status || "protocol_error",
		verified: false,
		correct: false,
		verificationOutcome: "infra_error",
		failureCategory: status || "protocol_error",
		challenge_id: payload.challenge_id ?? challengeId,
	};
}

function socketRequest(
	socketPath: string,
	payload: Record<string, unknown>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const encoded = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
	if (encoded.byteLength > MAX_VERIFY_REQUEST_BYTES)
		return Promise.reject(new FlagOracleProtocolError("Flag Oracle verification request exceeded 8192 bytes"));
	if (signal?.aborted) return Promise.reject(new FlagOracleAbortedError("Flag Oracle verification aborted"));
	return new Promise((resolve, reject) => {
		let socket: Socket | undefined;
		let settled = false;
		let buffer = Buffer.alloc(0);
		const timer = setTimeout(() => {
			finish(new FlagOracleTimeoutError("Flag Oracle request timed out"));
		}, timeoutMs);
		timer.unref();
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (socket && !socket.destroyed) socket.destroy();
		};
		const finish = (error?: Error, value?: Record<string, unknown>) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else if (value) resolve(value);
			else reject(new FlagOracleProtocolError("Flag Oracle returned an empty response"));
		};
		const parse = (raw: Uint8Array) => {
			try {
				finish(undefined, decodeObject(raw));
			} catch (error) {
				finish(error instanceof Error ? error : new FlagOracleProtocolError(String(error)));
			}
		};
		const onAbort = () => finish(new FlagOracleAbortedError("Flag Oracle verification aborted"));
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			socket = createConnection(socketPath);
			socket.once("connect", () => {
				try {
					socket?.write(encoded, (error) => {
						if (error) finish(new FlagOracleUnavailableError(`Flag Oracle write failed: ${error.message}`));
					});
				} catch (error) {
					finish(new FlagOracleUnavailableError(`Flag Oracle write failed: ${error instanceof Error ? error.message : String(error)}`));
				}
			});
			socket.on("data", (chunk: Buffer | string) => {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
				buffer = Buffer.concat([buffer, bytes]);
				if (buffer.byteLength > MAX_RESPONSE_BYTES) {
					finish(new FlagOracleProtocolError("Flag Oracle response exceeded 1000000 bytes"));
					return;
				}
				const newline = buffer.indexOf(10);
				if (newline >= 0) parse(buffer.subarray(0, newline));
			});
			socket.once("error", (error) => {
				finish(new FlagOracleUnavailableError(`Flag Oracle is unavailable: ${error.message}`));
			});
			socket.once("close", () => {
				if (settled) return;
				if (buffer.byteLength > 0) parse(buffer);
				else finish(new FlagOracleUnavailableError("Flag Oracle connection closed before a response"));
			});
		} catch (error) {
			finish(new FlagOracleUnavailableError(`Flag Oracle is unavailable: ${error instanceof Error ? error.message : String(error)}`));
		}
	});
}

export class FlagOracleClient {
	private readonly env: NodeJS.ProcessEnv;

	constructor(env: NodeJS.ProcessEnv = process.env) {
		this.env = { ...env };
	}

	async verify(input: FlagOracleVerifyInput, signal?: AbortSignal): Promise<FlagOracleVerifyResult> {
		const envPath =
			this.env.CTF_ORACLE_CLIENT_ENV_FILE?.trim() || join(homedir(), ".config", "secheur-agent", "oracle-client.env");
		const file = parseEnvFile(envPath);
		const challengeId = String(input.challengeId ?? "").trim() ||
			resolveEnvValue(this.env, file, ["CTF_CHALLENGE_ID", "SECHEUR_TARGET_ID", "CTF_TARGET_ID", "TARGET_ID", "SECHEUR_CHALLENGE_ID"], "");
		const agentId = String(input.agentId ?? "").trim() ||
			resolveEnvValue(this.env, file, ["FLAG_ORACLE_AGENT_ID", "CTF_AGENT_ID"], DEFAULT_VERIFY_AGENT_ID);
		const runId = String(input.runId ?? "").trim() ||
			resolveEnvValue(this.env, file, ["FLAG_ORACLE_RUN_ID", "CTF_RUN_ID", "SECHEUR_RUN_ID"], DEFAULT_VERIFY_RUN_ID);
		const config = loadConfig(this.env);
		const payload = {
			flag: String(input.flag ?? ""),
			challenge_id: challengeId,
			agent_id: agentId,
			run_id: runId,
		};
		const response = config.socketPath
			? await socketRequest(config.socketPath, payload, config.timeoutMs, signal)
			: await request(this.env, "/api/v1/verify", { method: "POST", body: payload, signal });
		return normalizeVerifyResponse(response, challengeId);
	}
}

export function flagOracleInfrastructureResult(
	error: unknown,
	challengeId?: string,
): FlagOracleVerifyResult {
	const message = error instanceof Error ? error.message : String(error);
	const status =
		error instanceof FlagOracleAbortedError
			? "aborted"
			: error instanceof FlagOracleTimeoutError
				? "timeout"
				: error instanceof FlagOracleProtocolError
					? "protocol_error"
					: error instanceof FlagOracleConfigurationError
						? "invalid_request"
						: "transport_error";
	return {
		ok: false,
		status,
		verified: false,
		correct: false,
		verificationOutcome: "infra_error",
		failureCategory: status,
		message,
		...(challengeId ? { challenge_id: challengeId } : {}),
	};
}

export function flagOracleSummary(env: NodeJS.ProcessEnv, limit: number): Promise<Record<string, unknown>> {
	return request(env, `/api/v1/summary?limit=${limit}`);
}

export function flagOracleAttempts(
	env: NodeJS.ProcessEnv,
	challengeId: string,
	limit: number,
): Promise<Record<string, unknown>> {
	const query = new URLSearchParams({ limit: String(limit) });
	if (challengeId) query.set("challengeId", challengeId);
	return request(env, `/api/v1/attempts?${query.toString()}`);
}
