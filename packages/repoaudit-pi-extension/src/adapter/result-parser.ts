import { readFile } from "node:fs/promises";
import type { LocatedArtifacts } from "./artifact-locator.ts";
import type { RepoAuditBugType, RepoAuditFinding, RepoAuditStatus } from "./contracts.ts";
import { RepoAuditError } from "./errors.ts";

export const LOG_ERROR_MARKERS = [
	"Error processing source value:",
	"API error:",
	"Operation failed:",
	"Max retries reached",
] as const;

const BUG_TYPES = new Set<RepoAuditBugType>(["MLK", "NPD", "UAF"]);

interface RawFinding {
	bug_type: string;
	buggy_value: string;
	relevant_functions: [unknown[], unknown[], unknown[]];
	explanation: string;
	is_human_confirmed_true: string;
}

export interface ParsedArtifactResult {
	status: Exclude<RepoAuditStatus, "failed">;
	findings: RepoAuditFinding[];
	summaryCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRawFinding(value: unknown): RawFinding {
	if (!isRecord(value)) {
		throw new RepoAuditError("RESULT_PARSE_ERROR", "finding 必须是 object。");
	}
	const relevant = value.relevant_functions;
	if (
		typeof value.bug_type !== "string" ||
		typeof value.buggy_value !== "string" ||
		typeof value.explanation !== "string" ||
		typeof value.is_human_confirmed_true !== "string" ||
		!Array.isArray(relevant) ||
		relevant.length < 3 ||
		!Array.isArray(relevant[0]) ||
		!Array.isArray(relevant[1]) ||
		!Array.isArray(relevant[2])
	) {
		throw new RepoAuditError("RESULT_PARSE_ERROR", "finding 字段结构不符合运行契约。");
	}
	return {
		bug_type: value.bug_type,
		buggy_value: value.buggy_value,
		relevant_functions: [relevant[0], relevant[1], relevant[2]],
		explanation: value.explanation,
		is_human_confirmed_true: value.is_human_confirmed_true,
	};
}

function normalizeHumanConfirmation(rawValue: string): boolean | null {
	const normalized = rawValue.trim().toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	return null;
}

function normalizeSummary(explanation: string): string {
	const compact = explanation.replace(/\s+/g, " ").trim();
	return compact.length <= 500 ? compact : `${compact.slice(0, 497)}...`;
}

function escapeRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseBuggyLocation(
	rawValue: string,
	fallbackFiles: readonly string[],
): { file: string | null; line: number | null } {
	for (const candidate of fallbackFiles) {
		const pattern = new RegExp(`,\\s*${escapeRegularExpression(candidate)},\\s*(\\d+),\\s*-?\\d+\\)`);
		const match = pattern.exec(rawValue);
		if (match?.[1] !== undefined) {
			return { file: candidate, line: Number(match[1]) };
		}
	}
	const lineMatch = /,\s*(\d+),\s*-?\d+\),\s*[^)]+\)$/.exec(rawValue);
	return {
		file: fallbackFiles[0] ?? null,
		line: lineMatch?.[1] === undefined ? null : Number(lineMatch[1]),
	};
}

function toFinding(id: string, raw: RawFinding): RepoAuditFinding {
	if (!BUG_TYPES.has(raw.bug_type as RepoAuditBugType)) {
		throw new RepoAuditError("RESULT_PARSE_ERROR", "finding bug_type 不受支持。");
	}
	const files = raw.relevant_functions[0].filter((value): value is string => typeof value === "string");
	const names = raw.relevant_functions[1].filter((value): value is string => typeof value === "string");
	const sources = raw.relevant_functions[2].filter((value): value is string => typeof value === "string");
	// Parallel arrays are consumed only up to their shortest length. The public
	// result intentionally omits function source; the raw JSON remains reportPath.
	const safeLength = Math.min(files.length, names.length, sources.length);
	const safeFiles = files.slice(0, safeLength || files.length);
	const location = parseBuggyLocation(raw.buggy_value, safeFiles);
	return {
		id,
		vulnerabilityType: raw.bug_type as RepoAuditBugType,
		file: location.file,
		line: location.line,
		summary: normalizeSummary(raw.explanation),
		verification: {
			pathValidatorAccepted: true,
			humanConfirmed: normalizeHumanConfirmation(raw.is_human_confirmed_true),
		},
	};
}

export function parseDetectInfoJson(jsonText: string, expectedBugType?: RepoAuditBugType): RepoAuditFinding[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (error) {
		throw new RepoAuditError("RESULT_PARSE_ERROR", "detect_info.json 不是合法 JSON。", {
			cause: error,
		});
	}
	if (!isRecord(parsed)) {
		throw new RepoAuditError("RESULT_PARSE_ERROR", "detect_info.json 顶层必须是 object。");
	}
	const findings = Object.entries(parsed).map(([id, value]) => toFinding(id, parseRawFinding(value)));
	if (expectedBugType !== undefined && findings.some((finding) => finding.vulnerabilityType !== expectedBugType)) {
		throw new RepoAuditError("RESULT_PARSE_ERROR", "detect_info.json 包含与请求不一致的 bug_type。");
	}
	return findings;
}

export function detectLogFailure(logText: string): RepoAuditError | null {
	const hasMarker = LOG_ERROR_MARKERS.some((marker) => logText.includes(marker));
	const hasTraceback = /(^|\n)Traceback \(most recent call last\):/.test(logText);
	const hasUnhandled = /(^|\n).*Unhandled exception(?::|\s|$)/i.test(logText);
	if (!hasMarker && !hasTraceback && !hasUnhandled) return null;
	if (/ANTHROPIC_API_KEY|OPENAI_API_KEY|DEEPSEEK_API_KEY2|GOOGLE_API_KEY|Please set .*API_KEY/i.test(logText)) {
		return new RepoAuditError("API_KEY_MISSING", "RepoAudit worker 需要的模型 API key 未配置。");
	}
	return new RepoAuditError("ANALYSIS_FAILED", "RepoAudit log 包含 worker、API 或未处理异常标记。");
}

function summaryCount(text: string): number | null {
	const matches = [...text.matchAll(/(\d+)\s+bug\(s\)\s+was\/were detected in total\./g)];
	const last = matches.at(-1);
	return last?.[1] === undefined ? null : Number(last[1]);
}

export async function parseRunArtifacts(
	artifacts: LocatedArtifacts,
	stdout: string,
	expectedBugType: RepoAuditBugType,
): Promise<ParsedArtifactResult> {
	const logText = await readFile(artifacts.logPath, "utf8");
	const logFailure = detectLogFailure(logText);
	if (logFailure !== null) throw logFailure;
	const declaredCount = summaryCount(`${logText}\n${stdout}`);

	if (artifacts.reportPath !== null) {
		const findings = parseDetectInfoJson(await readFile(artifacts.reportPath, "utf8"), expectedBugType);
		if (declaredCount !== null && declaredCount !== findings.length) {
			throw new RepoAuditError("ANALYSIS_FAILED", "RepoAudit summary 与 detect_info.json finding 数量不一致。");
		}
		return {
			status: findings.length > 0 ? "success_with_findings" : "success_no_findings",
			findings,
			summaryCount: findings.length,
		};
	}

	if (declaredCount === 0) {
		return { status: "success_no_findings", findings: [], summaryCount: 0 };
	}
	throw new RepoAuditError(
		"RESULT_NOT_FOUND",
		declaredCount !== null && declaredCount > 0
			? "RepoAudit 声明存在 finding，但 detect_info.json 不存在。"
			: "缺少 detect_info.json，且 log/stdout 没有明确的零 finding summary。",
	);
}
