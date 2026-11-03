import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

import type {
	RepoAuditErrorCode,
	RepoAuditExecutionInfo,
	RepoAuditFinding,
	RepoAuditResult,
	RepoAuditStatus,
} from "../adapter/contracts.ts";

export interface RepoAuditToolExecutionSummary {
	runId: string;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	exitCode: number | null;
	signal: string | null;
}

export interface RepoAuditToolFinalDetails {
	tool: "RepoAudit";
	phase: "completed";
	status: RepoAuditStatus;
	repository: string;
	language: RepoAuditResult["language"];
	bugType: RepoAuditResult["bugType"];
	findingCount: number;
	findings: RepoAuditFinding[];
	reportPath: string | null;
	logPath: string | null;
	execution: RepoAuditToolExecutionSummary;
}

export interface RepoAuditToolProgressDetails {
	tool: "RepoAudit";
	phase: "preparing" | "running" | "processing";
	message: string;
	runId: string;
	elapsedSeconds: number;
	heartbeat: boolean;
}

export type RepoAuditToolDetails = RepoAuditToolFinalDetails | RepoAuditToolProgressDetails;

export interface RepoAuditToolFailureDetails extends RepoAuditToolFinalDetails {
	status: "failed";
	error: {
		code: RepoAuditErrorCode;
		message: string;
		recoverable: boolean;
		suggestion: string;
	};
}

const SAFE_ERROR_MESSAGES: Record<RepoAuditErrorCode, string> = {
	RUNTIME_NOT_FOUND: "The RepoAudit runtime could not be located or is incomplete.",
	REPOSITORY_NOT_FOUND: "The requested repository path does not exist or is not a directory.",
	NO_ANALYZABLE_FILES: "No source files matching the selected language were found.",
	PYTHON_NOT_FOUND: "The configured RepoAudit Python runtime is unavailable.",
	PYTHON_VERSION_UNSUPPORTED: "The configured Python version is not supported by this RepoAudit runtime.",
	DEPENDENCY_MISSING: "The RepoAudit Python runtime is missing a required dependency.",
	TREE_SITTER_NOT_READY: "The RepoAudit Tree-sitter runtime is not ready for the selected language.",
	API_KEY_MISSING: "RepoAudit analysis could not complete because the configured model credential is unavailable.",
	UNSUPPORTED_LANGUAGE: "The requested source language is not supported by RepoAudit.",
	UNSUPPORTED_BUG_TYPE: "The requested vulnerability class is not supported by RepoAudit.",
	UNSUPPORTED_LANGUAGE_BUG_COMBINATION:
		"The selected language and vulnerability class combination is not supported by RepoAudit.",
	MODEL_CONFIGURATION_ERROR: "The internal RepoAudit model configuration is invalid.",
	ANALYSIS_FAILED: "RepoAudit analysis did not complete successfully.",
	RESULT_NOT_FOUND: "RepoAudit did not produce the required result artifact.",
	RESULT_AMBIGUOUS: "RepoAudit produced ambiguous result artifacts; retry the scan serially.",
	RESULT_PARSE_ERROR: "RepoAudit produced a result artifact that could not be safely parsed.",
	SCAN_TIMEOUT: "RepoAudit analysis timed out inside the plugin.",
	USER_ABORTED: "RepoAudit analysis was cancelled by the user or an unspecified caller.",
	HOST_WATCHDOG_ABORTED: "RepoAudit analysis was cancelled by an explicitly identified host watchdog.",
	LOCK_TIMEOUT: "RepoAudit could not acquire the cross-process scan lock in time.",
	LOCK_LEASE_LOST: "RepoAudit stopped because exclusive scan ownership was lost during execution.",
};

function executionSummary(execution: RepoAuditExecutionInfo): RepoAuditToolExecutionSummary {
	return {
		runId: execution.runId,
		startedAt: execution.startedAt,
		endedAt: execution.endedAt,
		durationMs: execution.durationMs,
		exitCode: execution.exitCode,
		signal: execution.signal,
	};
}

function finalDetails(result: RepoAuditResult): RepoAuditToolFinalDetails {
	return {
		tool: "RepoAudit",
		phase: "completed",
		status: result.status,
		repository: result.repoPath,
		language: result.language,
		bugType: result.bugType,
		findingCount: result.findingCount,
		findings: result.findings,
		reportPath: result.reportPath,
		logPath: result.logPath,
		execution: executionSummary(result.execution),
	};
}

function compactFinding(finding: RepoAuditFinding): string {
	const location =
		finding.file === null ? "unknown location" : `${finding.file}${finding.line === null ? "" : `:${finding.line}`}`;
	const summary = finding.summary.length <= 240 ? finding.summary : `${finding.summary.slice(0, 237)}...`;
	return `- [${finding.id}] ${finding.vulnerabilityType} at ${location}: ${summary}`;
}

function successContent(result: RepoAuditResult): string {
	const header = [
		"Tool: RepoAudit",
		`Status: ${result.status}`,
		`Repository: ${result.repoPath}`,
		`Language: ${result.language}`,
		`Bug type: ${result.bugType}`,
		`Finding count: ${result.findingCount}`,
	];

	if (result.status === "success_no_findings") {
		return [
			...header,
			"",
			"RepoAudit completed successfully.",
			"No accepted findings were reported for the selected language / bug type.",
			`Report path: ${result.reportPath ?? "not generated"}`,
			`Log path: ${result.logPath ?? "not available"}`,
			`Execution: ${result.execution.durationMs} ms, exit code ${result.execution.exitCode ?? "unknown"}.`,
		].join("\n");
	}

	const visibleFindings = result.findings.slice(0, 10).map(compactFinding);
	if (result.findings.length > visibleFindings.length) {
		visibleFindings.push(
			`- ${result.findings.length - visibleFindings.length} additional finding(s) are available in the report.`,
		);
	}
	return [
		...header,
		"",
		"Accepted findings:",
		...visibleFindings,
		"",
		`Report path: ${result.reportPath ?? "not generated"}`,
		`Log path: ${result.logPath ?? "not available"}`,
		`Execution: ${result.execution.durationMs} ms, exit code ${result.execution.exitCode ?? "unknown"}.`,
	].join("\n");
}

export class RepoAuditToolExecutionError extends Error {
	readonly details: RepoAuditToolFailureDetails;

	constructor(details: RepoAuditToolFailureDetails) {
		const lines = [
			"RepoAudit analysis failed.",
			`Error code: ${details.error.code}`,
			`Message: ${details.error.message}`,
			`Recoverable: ${details.error.recoverable ? "yes" : "no"}`,
			`Suggestion: ${details.error.suggestion}`,
		];
		if (details.logPath !== null) lines.push(`Log path: ${details.logPath}`);
		super(lines.join("\n"));
		this.name = "RepoAuditToolExecutionError";
		this.details = details;
	}
}

export function mapRepoAuditResult(result: RepoAuditResult): AgentToolResult<RepoAuditToolFinalDetails> {
	if (result.status === "failed") {
		const code = result.error?.code ?? "ANALYSIS_FAILED";
		const details: RepoAuditToolFailureDetails = {
			...finalDetails(result),
			status: "failed",
			error: {
				code,
				message: SAFE_ERROR_MESSAGES[code],
				recoverable: result.error?.recoverable ?? false,
				suggestion: result.error?.suggestion ?? "Inspect RepoAudit doctor output and retry.",
			},
		};
		throw new RepoAuditToolExecutionError(details);
	}

	return {
		content: [{ type: "text", text: successContent(result) }],
		details: finalDetails(result),
	};
}

export function progressResult(
	phase: RepoAuditToolProgressDetails["phase"],
	message: string,
	runId: string,
	elapsedSeconds: number,
	heartbeat = false,
): AgentToolResult<RepoAuditToolDetails> {
	return {
		content: [{ type: "text", text: message }],
		details: { tool: "RepoAudit", phase, message, runId, elapsedSeconds, heartbeat },
	};
}
