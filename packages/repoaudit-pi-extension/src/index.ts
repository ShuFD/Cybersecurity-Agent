import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { runRepoAudit } from "./adapter/run-repoaudit.ts";
import {
	createRepoAuditTool,
	type RepoAuditToolRuntimeOptions,
	type RunRepoAudit,
} from "./extension/repoaudit-tool.ts";

export {
	createRuntimeConfig,
	RUNTIME_DEFAULTS,
	RUNTIME_ENVIRONMENT_NAMES,
} from "./adapter/config.ts";
export type {
	RepoAuditBugType,
	RepoAuditErrorCode,
	RepoAuditExecutionInfo,
	RepoAuditFinding,
	RepoAuditLanguage,
	RepoAuditProgress,
	RepoAuditResult,
	RepoAuditRunOptions,
	RepoAuditRuntimeOptions,
	RepoAuditStatus,
} from "./adapter/contracts.ts";
export {
	type RepoAuditDoctorCheck,
	type RepoAuditDoctorOptions,
	type RepoAuditDoctorResult,
	runRepoAuditDoctor,
} from "./adapter/doctor.ts";
export {
	acquireRepoAuditFileLock,
	type RepoAuditFileLock,
	type RepoAuditFileLockOptions,
	type RepoAuditLockMetadata,
} from "./adapter/file-lock.ts";
export { createRepoAuditRunId, runRepoAudit } from "./adapter/run-repoaudit.ts";
export {
	createRepoAuditTool,
	REPOAUDIT_PROMPT_GUIDELINES,
	REPOAUDIT_PROMPT_SNIPPET,
	REPOAUDIT_TOOL_DESCRIPTION,
	type RepoAuditToolDefinition,
	type RepoAuditToolRuntimeOptions,
} from "./extension/repoaudit-tool.ts";
export {
	mapRepoAuditResult,
	type RepoAuditToolDetails,
	RepoAuditToolExecutionError,
	type RepoAuditToolFinalDetails,
} from "./extension/result-mapper.ts";
export {
	type RepoAuditScanParams,
	repoAuditScanSchema,
} from "./extension/schema.ts";

export function createRepoAuditExtension(
	runRepoAuditImplementation: RunRepoAudit = runRepoAudit,
	toolRuntimeOptions: RepoAuditToolRuntimeOptions = {},
): ExtensionFactory {
	return (pi) => {
		pi.registerTool(createRepoAuditTool(runRepoAuditImplementation, toolRuntimeOptions));
	};
}

const extension: ExtensionFactory = createRepoAuditExtension();

export default extension;
