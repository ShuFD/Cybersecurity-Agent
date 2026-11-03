const DEFAULT_OSV_API_URL = "https://api.osv.dev";
const DEFAULT_OSV_TIMEOUT_MS = 10_000;
const DEFAULT_OSV_CACHE_TTL_MS = 10 * 60_000;
const MAX_OSV_TARGETS = 20;
const MAX_OSV_VULNERABILITIES = 50;
const MAX_OSV_PAGES = 3;
const MAX_OSV_DETAIL_CONCURRENCY = 4;
const MAX_OSV_SUMMARY_LENGTH = 1_000;
const MAX_OSV_REFERENCES = 8;
const MAX_OSV_AFFECTED = 8;
const MAX_OSV_SELECTOR_LENGTH = 512;

export type OsvTargetClassification = "real_world_software" | "constructed_ctf" | "uncertain";
export type OsvQueryStatus = "ok" | "invalid" | "unavailable";
export type OsvTargetResultStatus = "matched" | "none" | "unavailable";

export interface OsvTargetInput {
	packageName?: string;
	ecosystem?: string;
	version?: string;
	purl?: string;
	commit?: string;
	evidenceRefs: string[];
}

export interface OsvNormalizedTarget {
	query: OsvApiQuery;
	queryKind: "package" | "purl" | "commit";
	identity: string;
	evidenceRefs: string[];
}

export interface OsvVulnerabilitySummary {
	id: string;
	modified?: string;
	summary?: string;
	severity?: string[];
	affected: OsvAffectedPackage[];
	references: string[];
}

export interface OsvAffectedPackage {
	name?: string;
	ecosystem?: string;
	ranges: string[];
	fixedVersions: string[];
}

export interface OsvTargetResult {
	identity: string;
	queryKind: OsvNormalizedTarget["queryKind"];
	status: OsvTargetResultStatus;
	vulnerabilities: OsvVulnerabilitySummary[];
	truncated?: boolean;
	error?: string;
}

export interface OsvQueryResult {
	status: OsvQueryStatus;
	results: OsvTargetResult[];
	queryCount: number;
	vulnerabilityCount: number;
	truncated: boolean;
	warnings: string[];
}

export interface OsvClientOptions {
	apiUrl?: string;
	timeoutMs?: number;
	cacheTtlMs?: number;
	fetchImpl?: typeof fetch;
}

export interface OsvApiQuery {
	commit?: string;
	version?: string;
	package?: { name?: string; ecosystem?: string; purl?: string };
	page_token?: string;
}

interface OsvBatchResult {
	vulns?: unknown;
	next_page_token?: unknown;
}

interface OsvBatchResponse {
	results?: unknown;
}

interface OsvCacheEntry {
	expiresAt: number;
	result: OsvQueryResult;
}

interface OsvDetailRecord {
	id?: unknown;
	modified?: unknown;
	summary?: unknown;
	severity?: unknown;
	affected?: unknown;
	references?: unknown;
}

export class OsvInputError extends Error {
	readonly code = "invalid_input";

	constructor(message: string) {
		super(message);
		this.name = "OsvInputError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new OsvInputError(`${field} must be a non-empty string`);
	return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	const normalized = nonEmptyString(value, field);
	if (normalized.length > MAX_OSV_SELECTOR_LENGTH) throw new OsvInputError(`${field} is too long`);
	return normalized;
}

function boundedText(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizedBaseUrl(value: string | undefined): string {
	const raw = (value?.trim() || DEFAULT_OSV_API_URL).replace(/\/+$/u, "");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new OsvInputError("OSV API URL is invalid");
	}
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))
	)
		throw new OsvInputError("OSV API URL must use HTTPS unless it targets localhost");
	return url.pathname.replace(/\/+$/u, "").endsWith("/v1") ? raw : `${raw}/v1`;
}

function purlHasVersion(purl: string): boolean {
	const queryStart = purl.search(/[?#]/u);
	const body = queryStart < 0 ? purl : purl.slice(0, queryStart);
	const versionSeparator = body.lastIndexOf("@");
	return versionSeparator > body.lastIndexOf("/") && Boolean(body.slice(versionSeparator + 1));
}

export function normalizeOsvTarget(input: OsvTargetInput, index = 0): OsvNormalizedTarget {
	const packageName = optionalString(input.packageName, `targets[${index}].packageName`);
	const ecosystem = optionalString(input.ecosystem, `targets[${index}].ecosystem`);
	const version = optionalString(input.version, `targets[${index}].version`);
	const purl = optionalString(input.purl, `targets[${index}].purl`);
	const commit = optionalString(input.commit, `targets[${index}].commit`);
	if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0)
		throw new OsvInputError(`targets[${index}].evidenceRefs must contain at least one reference`);
	const evidenceRefs = input.evidenceRefs.map((ref, refIndex) => {
		const value = nonEmptyString(ref, `targets[${index}].evidenceRefs[${refIndex}]`);
		if (value.length > 512) throw new OsvInputError(`targets[${index}].evidenceRefs[${refIndex}] is too long`);
		return value;
	});

	if (commit) {
		if (packageName || ecosystem || version || purl)
			throw new OsvInputError(`targets[${index}] mixes commit and package selectors`);
		if (!/^[a-f\d]{40}(?:[a-f\d]{24})?$/iu.test(commit))
			throw new OsvInputError(`targets[${index}].commit must be a full 40 or 64 character hash`);
		return {
			query: { commit },
			queryKind: "commit",
			identity: `commit:${commit.toLowerCase()}`,
			evidenceRefs,
		};
	}

	if (purl) {
		if (packageName || ecosystem || version)
			throw new OsvInputError(`targets[${index}] mixes PURL and package selectors`);
		if (!purl.startsWith("pkg:") || !purlHasVersion(purl))
			throw new OsvInputError(`targets[${index}].purl must be a versioned Package URL`);
		return { query: { package: { purl } }, queryKind: "purl", identity: `purl:${purl}`, evidenceRefs };
	}

	if (!packageName || !ecosystem || !version)
		throw new OsvInputError(
			`targets[${index}] requires packageName, ecosystem, and version, or a versioned purl, or a full commit hash`,
		);
	return {
		query: { package: { name: packageName, ecosystem }, version },
		queryKind: "package",
		identity: `package:${ecosystem}:${packageName}@${version}`,
		evidenceRefs,
	};
}

function abortReason(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error ? signal.reason : new Error("OSV request aborted");
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = (): void => {
			cleanup();
			reject(abortReason(signal));
		};
		const cleanup = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function responseStatus(value: unknown): string {
	return typeof value === "number" ? String(value) : "unknown";
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? boundedText(value.trim(), MAX_OSV_SUMMARY_LENGTH) : undefined;
}

function referenceUrls(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!isRecord(entry) || typeof entry.url !== "string" || !entry.url.trim()) return [];
		return [boundedText(entry.url.trim(), 512)];
	});
}

function severityValues(value: unknown): string[] {
	if (typeof value === "string" && value.trim()) return [boundedText(value.trim(), 120)];
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!isRecord(entry)) return [];
		const type = typeof entry.type === "string" ? entry.type.trim() : "";
		const score = typeof entry.score === "string" ? entry.score.trim() : "";
		return [type && score ? `${type}: ${score}` : type || score]
			.filter(Boolean)
			.map((item) => boundedText(item, 120));
	});
}

function affectedPackages(value: unknown): OsvAffectedPackage[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, MAX_OSV_AFFECTED).flatMap((entry) => {
		if (!isRecord(entry)) return [];
		const packageValue = isRecord(entry.package) ? entry.package : {};
		const name = typeof packageValue.name === "string" ? boundedText(packageValue.name.trim(), 200) : undefined;
		const ecosystem =
			typeof packageValue.ecosystem === "string" ? boundedText(packageValue.ecosystem.trim(), 120) : undefined;
		const ranges: string[] = [];
		const fixedVersions: string[] = [];
		if (Array.isArray(entry.ranges)) {
			for (const range of entry.ranges) {
				if (!isRecord(range)) continue;
				const type = typeof range.type === "string" ? range.type.trim() : "";
				const events = Array.isArray(range.events)
					? range.events.flatMap((event) => {
							if (!isRecord(event)) return [];
							return Object.entries(event).flatMap(([key, value]) => {
								if (typeof value !== "string" || !value.trim()) return [];
								const boundedValue = boundedText(value.trim(), 160);
								if (key === "fixed") fixedVersions.push(boundedValue);
								return [`${key} ${boundedValue}`];
							});
						})
					: [];
				const value = [type, ...events].filter(Boolean).join(": ");
				if (value) ranges.push(boundedText(value, 320));
			}
		}
		if (!name && !ecosystem && ranges.length === 0 && fixedVersions.length === 0) return [];
		return [
			{
				...(name ? { name } : {}),
				...(ecosystem ? { ecosystem } : {}),
				ranges,
				fixedVersions: [...new Set(fixedVersions)].slice(0, 12),
			},
		];
	});
}

function summarizeVulnerability(
	value: unknown,
	fallbackId?: string,
	fallbackModified?: string,
): OsvVulnerabilitySummary | undefined {
	if (!isRecord(value))
		return fallbackId
			? { id: fallbackId, ...(fallbackModified ? { modified: fallbackModified } : {}), affected: [], references: [] }
			: undefined;
	const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : fallbackId;
	if (!id) return undefined;
	const databaseSpecific = isRecord(value.database_specific) ? value.database_specific : {};
	const severity = [
		...severityValues(value.severity),
		...severityValues(databaseSpecific.severity),
		...(Array.isArray(value.affected)
			? value.affected.flatMap((entry) =>
					isRecord(entry) && isRecord(entry.ecosystem_specific)
						? severityValues(entry.ecosystem_specific.severity)
						: [],
				)
			: []),
	];
	return {
		id,
		...(typeof value.modified === "string" && value.modified.trim()
			? { modified: value.modified.trim() }
			: fallbackModified
				? { modified: fallbackModified }
				: {}),
		...(stringField(value.summary) ? { summary: stringField(value.summary) } : {}),
		...(severity.length > 0 ? { severity: [...new Set(severity)].slice(0, 4) } : {}),
		affected: affectedPackages(value.affected),
		references: referenceUrls(value.references).slice(0, MAX_OSV_REFERENCES),
	};
}

function cloneResult(result: OsvQueryResult): OsvQueryResult {
	return JSON.parse(JSON.stringify(result)) as OsvQueryResult;
}

async function mapConcurrent<T, R>(
	values: T[],
	concurrency: number,
	operation: (value: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(values.length);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			const index = nextIndex++;
			if (index >= values.length) return;
			results[index] = await operation(values[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
	return results;
}

export class OsvClient {
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly cacheTtlMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly cache = new Map<string, OsvCacheEntry>();

	constructor(options: OsvClientOptions = {}) {
		this.baseUrl = normalizedBaseUrl(options.apiUrl);
		this.timeoutMs = Math.max(1_000, Math.min(30_000, Math.trunc(options.timeoutMs ?? DEFAULT_OSV_TIMEOUT_MS)));
		this.cacheTtlMs = Math.max(0, Math.trunc(options.cacheTtlMs ?? DEFAULT_OSV_CACHE_TTL_MS));
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async query(inputs: OsvTargetInput[], signal?: AbortSignal): Promise<OsvQueryResult> {
		if (!Array.isArray(inputs) || inputs.length === 0)
			throw new OsvInputError("OSV query requires at least one target");
		if (inputs.length > MAX_OSV_TARGETS)
			throw new OsvInputError(`OSV query supports at most ${MAX_OSV_TARGETS} targets`);
		const normalized = inputs.map((input, index) => normalizeOsvTarget(input, index));
		const cacheKey = JSON.stringify(normalized.map((target) => ({ query: target.query, identity: target.identity })));
		const cached = this.cache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) return cloneResult(cached.result);

		const result = await this.queryNormalized(normalized, signal);
		if (this.cacheTtlMs > 0 && result.status !== "invalid")
			this.cache.set(cacheKey, { expiresAt: Date.now() + this.cacheTtlMs, result: cloneResult(result) });
		return result;
	}

	private async queryNormalized(targets: OsvNormalizedTarget[], signal?: AbortSignal): Promise<OsvQueryResult> {
		const batchVulnerabilities = targets.map(() => new Map<string, string | undefined>());
		const pending = targets.map((target, index) => ({ target, index, pageToken: undefined as string | undefined }));
		let truncated = false;
		const warnings: string[] = [];
		try {
			for (let page = 0; page < MAX_OSV_PAGES && pending.length > 0; page += 1) {
				const pageRequests = pending.splice(0, pending.length);
				const response = await this.requestJson<OsvBatchResponse>(
					`${this.baseUrl}/querybatch`,
					{
						queries: pageRequests.map(({ target, pageToken }) => ({
							...target.query,
							...(pageToken ? { page_token: pageToken } : {}),
						})),
					},
					signal,
				);
				if (!Array.isArray(response.results)) throw new Error("OSV API returned an invalid querybatch response");
				const results = response.results;
				const nextPage: typeof pending = [];
				for (let index = 0; index < pageRequests.length; index += 1) {
					const pageRequest = pageRequests[index];
					const pageResult = isRecord(results[index]) ? (results[index] as OsvBatchResult) : {};
					const vulnerabilities = Array.isArray(pageResult.vulns) ? pageResult.vulns : [];
					for (const vulnerability of vulnerabilities) {
						if (!isRecord(vulnerability) || typeof vulnerability.id !== "string" || !vulnerability.id.trim())
							continue;
						const targetMap = batchVulnerabilities[pageRequest.index];
						if (
							!targetMap.has(vulnerability.id.trim()) &&
							totalVulnerabilityCount(batchVulnerabilities) >= MAX_OSV_VULNERABILITIES
						) {
							truncated = true;
							break;
						}
						targetMap.set(
							vulnerability.id.trim(),
							typeof vulnerability.modified === "string" ? vulnerability.modified.trim() : undefined,
						);
					}
					const nextToken =
						typeof pageResult.next_page_token === "string" && pageResult.next_page_token.trim()
							? pageResult.next_page_token.trim()
							: undefined;
					if (nextToken && !truncated) nextPage.push({ ...pageRequest, pageToken: nextToken });
					else if (nextToken) truncated = true;
				}
				pending.push(...nextPage);
			}
			if (pending.length > 0) truncated = true;
		} catch (error) {
			const message = boundedText(error instanceof Error ? error.message : String(error), 500);
			return {
				status: "unavailable",
				results: targets.map((target) => ({
					identity: target.identity,
					queryKind: target.queryKind,
					status: "unavailable",
					vulnerabilities: [],
					error: message,
				})),
				queryCount: targets.length,
				vulnerabilityCount: 0,
				truncated: false,
				warnings: [message],
			};
		}

		const ids = [...new Set(batchVulnerabilities.flatMap((items) => [...items.keys()]))];
		const details = await mapConcurrent(ids, MAX_OSV_DETAIL_CONCURRENCY, async (id) => {
			try {
				return {
					id,
					detail: await this.requestJson<OsvDetailRecord>(
						`${this.baseUrl}/vulns/${encodeURIComponent(id)}`,
						undefined,
						signal,
					),
				};
			} catch (error) {
				return { id, error: boundedText(error instanceof Error ? error.message : String(error), 500) };
			}
		});
		const detailById = new Map(details.map((item) => [item.id, item]));
		const targetResults = targets.map((target, index) => {
			const vulnerabilities = [...batchVulnerabilities[index].entries()].flatMap(([id, modified]) => {
				const detail = detailById.get(id);
				const summary = summarizeVulnerability(
					detail && "detail" in detail ? detail.detail : undefined,
					id,
					modified,
				);
				return summary ? [summary] : [];
			});
			const errors = [...batchVulnerabilities[index].keys()]
				.map((id) => detailById.get(id))
				.flatMap((detail) => (detail && "error" in detail ? [detail.error] : []));
			return {
				identity: target.identity,
				queryKind: target.queryKind,
				status: (vulnerabilities.length > 0 ? "matched" : "none") as OsvTargetResultStatus,
				vulnerabilities,
				...(errors.length > 0 ? { error: boundedText(errors.join("; "), 500) } : {}),
				...(truncated ? { truncated: true } : {}),
			};
		});
		if (truncated)
			warnings.push(
				`OSV results were capped at ${MAX_OSV_VULNERABILITIES} unique vulnerabilities or ${MAX_OSV_PAGES} pages`,
			);
		if (details.some((item) => "error" in item))
			warnings.push("Some OSV vulnerability details were unavailable; IDs remain in the result");
		return {
			status: "ok",
			results: targetResults,
			queryCount: targets.length,
			vulnerabilityCount: ids.length,
			truncated,
			warnings,
		};
	}

	private async requestJson<T>(url: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				const controller = new AbortController();
				const onAbort = (): void => controller.abort(signal?.reason);
				const timer = setTimeout(() => controller.abort(new Error("OSV request timed out")), this.timeoutMs);
				signal?.addEventListener("abort", onAbort, { once: true });
				if (signal?.aborted) controller.abort(signal.reason);
				try {
					const response = await this.fetchImpl(url, {
						method: body === undefined ? "GET" : "POST",
						headers: {
							accept: "application/json",
							...(body === undefined ? {} : { "content-type": "application/json" }),
						},
						...(body === undefined ? {} : { body: JSON.stringify(body) }),
						signal: controller.signal,
					});
					if (!response.ok) {
						const error = new Error(`OSV API returned HTTP ${responseStatus(response.status)}`);
						if ((response.status === 429 || response.status >= 500) && attempt === 0) {
							lastError = error;
							await wait(500, signal);
							continue;
						}
						throw error;
					}
					return (await response.json()) as T;
				} finally {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
				}
			} catch (error) {
				if (signal?.aborted) throw abortReason(signal);
				lastError = error;
				if (attempt === 0 && error instanceof Error && /HTTP (429|5\d\d)/u.test(error.message)) {
					await wait(500, signal);
					continue;
				}
				throw error;
			}
		}
		throw lastError instanceof Error ? lastError : new Error("OSV request failed");
	}
}

function totalVulnerabilityCount(values: Map<string, string | undefined>[]): number {
	return new Set(values.flatMap((items) => [...items.keys()])).size;
}

export const osvLimits = {
	maxTargets: MAX_OSV_TARGETS,
	maxVulnerabilities: MAX_OSV_VULNERABILITIES,
	maxPages: MAX_OSV_PAGES,
	maxDetailConcurrency: MAX_OSV_DETAIL_CONCURRENCY,
	maxSummaryLength: MAX_OSV_SUMMARY_LENGTH,
} as const;
