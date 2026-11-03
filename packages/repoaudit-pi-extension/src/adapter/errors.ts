import type { RepoAuditErrorCode, RepoAuditErrorSummary } from "./contracts.ts";

const RECOVERABLE_CODES = new Set<RepoAuditErrorCode>([
	"RUNTIME_NOT_FOUND",
	"PYTHON_NOT_FOUND",
	"NO_ANALYZABLE_FILES",
	"PYTHON_VERSION_UNSUPPORTED",
	"DEPENDENCY_MISSING",
	"TREE_SITTER_NOT_READY",
	"API_KEY_MISSING",
	"UNSUPPORTED_LANGUAGE",
	"UNSUPPORTED_BUG_TYPE",
	"UNSUPPORTED_LANGUAGE_BUG_COMBINATION",
	"MODEL_CONFIGURATION_ERROR",
	"RESULT_NOT_FOUND",
	"RESULT_AMBIGUOUS",
	"RESULT_PARSE_ERROR",
	"REPOSITORY_NOT_FOUND",
	"SCAN_TIMEOUT",
	"USER_ABORTED",
	"HOST_WATCHDOG_ABORTED",
	"LOCK_TIMEOUT",
	"LOCK_LEASE_LOST",
]);

export const RECOVERY_SUGGESTIONS: Record<RepoAuditErrorCode, string> = {
	RUNTIME_NOT_FOUND: "Set REPOAUDIT_ROOT to the RepoAudit runtime directory and retry.",
	PYTHON_NOT_FOUND: "Set REPOAUDIT_PYTHON to an executable Python 3.13 interpreter.",
	PYTHON_VERSION_UNSUPPORTED: "Use a Python 3.13 virtual environment dedicated to RepoAudit.",
	DEPENDENCY_MISSING: "Install the missing modules into REPOAUDIT_PYTHON using the RepoAudit requirements file.",
	TREE_SITTER_NOT_READY: "Build lib/build/my-languages.so and verify all required grammars load.",
	MODEL_CONFIGURATION_ERROR: "Set REPOAUDIT_MODEL to a supported model family and correct invalid numeric settings.",
	API_KEY_MISSING: "Set the credential environment variable reported by RepoAudit doctor, then retry.",
	REPOSITORY_NOT_FOUND: "Pass an existing checked-out source repository directory.",
	NO_ANALYZABLE_FILES: "Confirm the selected language and that the repository contains supported source files.",
	UNSUPPORTED_LANGUAGE: "Use one of Cpp, Java, Python, or Go.",
	UNSUPPORTED_BUG_TYPE: "Use one of NPD, UAF, or MLK.",
	UNSUPPORTED_LANGUAGE_BUG_COMBINATION: "Choose a combination from the documented RepoAudit support matrix.",
	SCAN_TIMEOUT: "Increase REPOAUDIT_TIMEOUT_MS after checking runtime capacity, or scan a smaller repository.",
	USER_ABORTED: "Start a new scan when cancellation is no longer desired.",
	HOST_WATCHDOG_ABORTED: "Check the host watchdog and heartbeat propagation before retrying the scan.",
	LOCK_TIMEOUT: "Wait for the active scan to finish or investigate a stale lock with RepoAudit doctor.",
	LOCK_LEASE_LOST:
		"Stop concurrent scans, verify lock storage reliability, and retry after the active owner is known.",
	RESULT_NOT_FOUND: "Inspect the run log and retry; the scan did not produce the required artifact evidence.",
	RESULT_AMBIGUOUS: "Ensure only one runtime writes the artifact tree and retry under the RepoAudit lock.",
	RESULT_PARSE_ERROR: "Preserve the artifact for diagnosis and verify runtime/plugin version compatibility.",
	ANALYSIS_FAILED: "Inspect the sanitized RepoAudit run log, correct the runtime failure, and retry.",
};

export class RepoAuditError extends Error {
	readonly code: RepoAuditErrorCode;
	readonly recoverable: boolean;

	constructor(code: RepoAuditErrorCode, message: string, options?: { cause?: unknown; recoverable?: boolean }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "RepoAuditError";
		this.code = code;
		this.recoverable = options?.recoverable ?? RECOVERABLE_CODES.has(code);
	}
}

export function asRepoAuditError(error: unknown): RepoAuditError {
	if (error instanceof RepoAuditError) {
		return error;
	}
	return new RepoAuditError("ANALYSIS_FAILED", "RepoAudit Adapter 遇到未预期的执行错误。", {
		cause: error,
		recoverable: false,
	});
}

export function toErrorSummary(error: RepoAuditError): RepoAuditErrorSummary {
	return {
		code: error.code,
		message: error.message,
		recoverable: error.recoverable,
		suggestion: RECOVERY_SUGGESTIONS[error.code],
	};
}
