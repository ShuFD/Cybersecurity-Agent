import path from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRuntimeConfig, RUNTIME_DEFAULTS } from "../adapter/config.ts";
import type { RepoAuditRunOptions } from "../adapter/contracts.ts";
import { createRepoAuditRunId, runRepoAudit } from "../adapter/run-repoaudit.ts";
import { mapRepoAuditResult, progressResult, type RepoAuditToolDetails } from "./result-mapper.ts";
import { type RepoAuditScanParams, repoAuditScanSchema } from "./schema.ts";

export type RunRepoAudit = typeof runRepoAudit;
export type RepoAuditToolDefinition = ToolDefinition<typeof repoAuditScanSchema, RepoAuditToolDetails>;

export interface RepoAuditToolRuntimeOptions {
	heartbeatMs?: number;
}

export const REPOAUDIT_TOOL_DESCRIPTION = `Analyze a source repository with RepoAudit for supported data-flow bugs.

Supported matrix:
- C/C++ (language=Cpp): NPD, UAF, MLK
- Java: NPD
- Python: NPD
- Go: NPD

Use for repository-level source-code security analysis of these supported data-flow bugs.
Do not use for Web pentesting, Network scanning, Binary/reverse analysis, Dependency vulnerability scanning, unsupported vulnerability classes, or Generic code review.`;

/**
 * One-line summary that Pi injects into the "Available tools" section of the
 * default system prompt when this tool is active.
 */
export const REPOAUDIT_PROMPT_SNIPPET =
	"Run RepoAudit Python on a local repository to detect supported data-flow bugs (NPD/UAF/MLK).";

/**
 * Guideline bullets appended to the "Guidelines" section of the default system
 * prompt. They tell the agent when to reach for repoaudit_scan, when to refuse,
 * and how to handle evidence returned by the tool.
 */
export const REPOAUDIT_PROMPT_GUIDELINES: readonly string[] = [
	"Use repoaudit_scan when the user asks for a repository-level audit of NPD (null-pointer dereference), UAF (use-after-free), or MLK (memory leak) data-flow bugs.",
	"Supported matrix: C/C++ allows NPD/UAF/MLK; Java, Python, and Go only allow NPD. Do not invoke other language/bug-type combinations.",
	"Do not use repoaudit_scan for web pentesting, network scanning, dependency/CVE scanning, binary reverse analysis, unsupported vulnerability classes, or generic code review.",
	"repoPath must point to a checked-out source tree; relative paths resolve against the current Pi working directory.",
	"Treat the tool's report as the only evidence: surface file:line, vulnerability type, and the supplied summary verbatim, and do not invent additional findings beyond what the tool returns.",
];

function toRunOptions(params: RepoAuditScanParams, cwd: string): RepoAuditRunOptions {
	const repoPath = path.isAbsolute(params.repoPath) ? params.repoPath : path.resolve(cwd, params.repoPath);
	return {
		repoPath,
		language: params.language,
		bugType: params.bugType,
	} as RepoAuditRunOptions;
}

export function createRepoAuditTool(
	runRepoAuditImplementation: RunRepoAudit = runRepoAudit,
	toolRuntimeOptions: RepoAuditToolRuntimeOptions = {},
): RepoAuditToolDefinition {
	return {
		name: "repoaudit_scan",
		label: "RepoAudit Scan",
		description: REPOAUDIT_TOOL_DESCRIPTION,
		parameters: repoAuditScanSchema,
		executionMode: "sequential",

		// System-prompt integration: surface the tool in "Available tools" and tell
		// the agent when to reach for it. Without these the agent only sees the
		// tool when the user explicitly names "RepoAudit" in natural language.
		promptSnippet: REPOAUDIT_PROMPT_SNIPPET,
		promptGuidelines: [...REPOAUDIT_PROMPT_GUIDELINES],

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const runId = createRepoAuditRunId();
			const startedAt = Date.now();
			let phase: "preparing" | "running" | "processing" = "preparing";
			let runtimePhase = "preparing";
			const elapsedSeconds = (): number => Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
			const update = (message: string, heartbeat = false): void => {
				try {
					onUpdate?.(progressResult(phase, message, runId, elapsedSeconds(), heartbeat));
				} catch {
					// Updates are observational; a host callback must not abort the scan.
				}
			};
			update("Preparing RepoAudit scan...");
			const options = toRunOptions(params, ctx.cwd);
			phase = "running";
			update("Running RepoAudit analysis...");
			let configuredHeartbeat = RUNTIME_DEFAULTS.heartbeatMs;
			try {
				configuredHeartbeat = createRuntimeConfig().heartbeatMs;
			} catch {
				/* scan returns config failure */
			}
			const heartbeatMs = toolRuntimeOptions.heartbeatMs ?? configuredHeartbeat;
			const heartbeatTimer = setInterval(() => {
				update(`RepoAudit heartbeat: run ${runId}; phase ${runtimePhase}; elapsed ${elapsedSeconds()}s.`, true);
			}, heartbeatMs);
			heartbeatTimer.unref?.();
			try {
				const result = await runRepoAuditImplementation(options, {
					...(signal === undefined ? {} : { signal }),
					runId,
					onProgress(progress) {
						runtimePhase = progress.phase;
						update(
							`RepoAudit progress: run ${progress.runId}; phase ${progress.phase}; elapsed ${progress.elapsedSeconds}s.`,
						);
					},
				});
				phase = "processing";
				runtimePhase = "processing";
				update("Processing RepoAudit result...");
				return mapRepoAuditResult(result);
			} finally {
				clearInterval(heartbeatTimer);
			}
		},
	};
}
