export type RepoAuditLanguage = "Cpp" | "Java" | "Python" | "Go";

export type RepoAuditBugType = "MLK" | "NPD" | "UAF";

export type RepoAuditRunOptions =
	| {
			repoPath: string;
			language: "Cpp";
			bugType: "MLK" | "NPD" | "UAF";
	  }
	| {
			repoPath: string;
			language: "Java" | "Python" | "Go";
			bugType: "NPD";
	  };

export type RepoAuditStatus = "success_with_findings" | "success_no_findings" | "failed";

export interface RepoAuditFinding {
	id: string;
	vulnerabilityType: RepoAuditBugType;
	file: string | null;
	line: number | null;
	summary: string;
	verification: {
		pathValidatorAccepted: true;
		humanConfirmed: boolean | null;
	};
}

export type RepoAuditFindingSummary = RepoAuditFinding;

export interface RepoAuditExecutionInfo {
	runId: string;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	exitCode: number | null;
	signal: string | null;
	pythonExecutable: string;
	pythonVersion: string;
	modelName: string;
	workingDirectory: string;
	resultDirectory: string | null;
	logDirectory: string | null;
	stdoutBytes: number;
	stderrBytes: number;
	artifactIsolation: "run_id" | "legacy_snapshot";
}

export type RepoAuditExecutionMetadata = RepoAuditExecutionInfo;

export type RepoAuditErrorCode =
	| "RUNTIME_NOT_FOUND"
	| "PYTHON_NOT_FOUND"
	| "PYTHON_VERSION_UNSUPPORTED"
	| "DEPENDENCY_MISSING"
	| "TREE_SITTER_NOT_READY"
	| "MODEL_CONFIGURATION_ERROR"
	| "API_KEY_MISSING"
	| "REPOSITORY_NOT_FOUND"
	| "NO_ANALYZABLE_FILES"
	| "UNSUPPORTED_LANGUAGE"
	| "UNSUPPORTED_BUG_TYPE"
	| "UNSUPPORTED_LANGUAGE_BUG_COMBINATION"
	| "SCAN_TIMEOUT"
	| "USER_ABORTED"
	| "HOST_WATCHDOG_ABORTED"
	| "LOCK_TIMEOUT"
	| "LOCK_LEASE_LOST"
	| "RESULT_NOT_FOUND"
	| "RESULT_AMBIGUOUS"
	| "RESULT_PARSE_ERROR"
	| "ANALYSIS_FAILED";

export interface RepoAuditErrorSummary {
	code: RepoAuditErrorCode;
	message: string;
	recoverable: boolean;
	suggestion: string;
}

export interface RepoAuditResult {
	status: RepoAuditStatus;
	tool: "repoaudit";
	bugType: RepoAuditBugType;
	language: RepoAuditLanguage;
	repoPath: string;
	findingCount: number;
	findings: RepoAuditFinding[];
	reportPath: string | null;
	logPath: string | null;
	execution: RepoAuditExecutionInfo;
	error?: RepoAuditErrorSummary;
}

export interface RepoAuditRuntimeOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	abortSource?: "user" | "host_watchdog";
	runId?: string;
	onProgress?: (progress: RepoAuditProgress) => void;
}

export interface RepoAuditProgress {
	runId: string;
	phase: string;
	elapsedSeconds: number;
}
