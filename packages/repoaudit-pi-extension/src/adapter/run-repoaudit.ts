import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { type LocatedArtifacts, locateArtifacts, snapshotArtifacts } from "./artifact-locator.ts";
import {
	buildChildEnvironment,
	buildRepoAuditArgs,
	createRuntimeConfig,
	type RepoAuditRuntimeConfig,
} from "./config.ts";
import type {
	RepoAuditBugType,
	RepoAuditExecutionInfo,
	RepoAuditLanguage,
	RepoAuditProgress,
	RepoAuditResult,
	RepoAuditRunOptions,
	RepoAuditRuntimeOptions,
} from "./contracts.ts";
import { asRepoAuditError, RepoAuditError, toErrorSummary } from "./errors.ts";
import { acquireRepoAuditFileLock } from "./file-lock.ts";
import { preflightRepoAudit } from "./preflight.ts";
import { type ProcessRunResult, runProcess } from "./process-runner.ts";
import { parseRunArtifacts } from "./result-parser.ts";

let executionQueue: Promise<void> = Promise.resolve();

export function createRepoAuditRunId(): string {
	return `run_${randomUUID().replaceAll("-", "")}`;
}

function fallbackRuntimeConfig(): RepoAuditRuntimeConfig {
	return {
		repoAuditRoot: "",
		rootSource: "inferred",
		repoAuditSrcDirectory: "",
		repoAuditEntryPoint: "",
		pythonExecutable: "",
		treeSitterLibrary: "",
		runsDirectory: "",
		lockDirectory: "",
		defaultTimeoutMs: 0,
		lockTimeoutMs: 0,
		lockStaleMs: 0,
		heartbeatMs: 25_000,
		modelName: "unknown",
		temperature: 0,
		callDepth: 3,
		maxSymbolicWorkers: 1,
		maxNeuralWorkers: 1,
		apiKeyEnvironmentName: null,
		requireApiKey: false,
		environment: {},
	};
}

function waitForQueue(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
	if (signal === undefined) return previous;
	if (signal.aborted) return Promise.reject(new RepoAuditError("USER_ABORTED", "RepoAudit scan was cancelled."));
	return new Promise((resolve, reject) => {
		const onAbort = (): void => reject(new RepoAuditError("USER_ABORTED", "RepoAudit scan was cancelled."));
		signal.addEventListener("abort", onAbort, { once: true });
		previous.then(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export async function withRepoAuditLock<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	const previous = executionQueue;
	let release!: () => void;
	executionQueue = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		await waitForQueue(previous, signal);
		if (signal?.aborted) throw new RepoAuditError("USER_ABORTED", "RepoAudit scan was cancelled.");
		return await action();
	} finally {
		release();
	}
}

function safeRequestedPath(options: RepoAuditRunOptions): string {
	const candidate = (options as { repoPath?: unknown }).repoPath;
	return typeof candidate === "string" && candidate.trim() !== "" ? path.resolve(candidate) : "";
}

function baseExecution(runId: string, config: RepoAuditRuntimeConfig, startedAt: Date): RepoAuditExecutionInfo {
	const endedAt = new Date();
	return {
		runId,
		startedAt: startedAt.toISOString(),
		endedAt: endedAt.toISOString(),
		durationMs: endedAt.getTime() - startedAt.getTime(),
		exitCode: null,
		signal: null,
		pythonExecutable: config.pythonExecutable,
		pythonVersion: "unknown",
		modelName: config.modelName,
		workingDirectory: config.repoAuditSrcDirectory,
		resultDirectory: null,
		logDirectory: null,
		stdoutBytes: 0,
		stderrBytes: 0,
		artifactIsolation: "legacy_snapshot",
	};
}

function executionFromProcess(
	runId: string,
	config: RepoAuditRuntimeConfig,
	pythonVersion: string,
	processResult: ProcessRunResult,
	artifacts?: LocatedArtifacts,
): RepoAuditExecutionInfo {
	return {
		runId,
		startedAt: processResult.startedAt,
		endedAt: processResult.endedAt,
		durationMs: processResult.durationMs,
		exitCode: processResult.exitCode,
		signal: processResult.signal,
		pythonExecutable: config.pythonExecutable,
		pythonVersion,
		modelName: config.modelName,
		workingDirectory: config.repoAuditSrcDirectory,
		resultDirectory: artifacts?.resultDirectory ?? null,
		logDirectory: artifacts?.logDirectory ?? null,
		stdoutBytes: processResult.stdoutBytes,
		stderrBytes: processResult.stderrBytes,
		artifactIsolation: artifacts === undefined ? "legacy_snapshot" : "run_id",
	};
}

function failedResult(
	options: RepoAuditRunOptions,
	repoPath: string,
	execution: RepoAuditExecutionInfo,
	error: RepoAuditError,
	artifacts?: LocatedArtifacts,
): RepoAuditResult {
	return {
		status: "failed",
		tool: "repoaudit",
		bugType: (options as { bugType: RepoAuditBugType }).bugType,
		language: (options as { language: RepoAuditLanguage }).language,
		repoPath,
		findingCount: 0,
		findings: [],
		reportPath: artifacts?.reportPath ?? null,
		logPath: artifacts?.logPath ?? null,
		execution,
		error: toErrorSummary(error),
	};
}

function emitProgress(runtimeOptions: RepoAuditRuntimeOptions, runId: string, phase: string, startedAt: number): void {
	const progress: RepoAuditProgress = {
		runId,
		phase: phase.slice(0, 80),
		elapsedSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
	};
	try {
		runtimeOptions.onProgress?.(progress);
	} catch {
		// Host progress callbacks are observational and must not fail the scan.
	}
}

function progressPhaseFromLine(line: string, expectedRunId: string): string | null {
	if (line.length > 64 * 1024 || !line.trim().startsWith("{")) return null;
	try {
		const value = JSON.parse(line) as Record<string, unknown>;
		const progress = value.repoaudit_progress;
		if (typeof progress === "object" && progress !== null) {
			const record = progress as Record<string, unknown>;
			if (record.run_id === expectedRunId && typeof record.stage === "string") return record.stage;
		}
		if (value.run_id === expectedRunId && typeof value.event_type === "string") return value.event_type;
	} catch {
		return null;
	}
	return null;
}

function explicitAbortSource(runtimeOptions: RepoAuditRuntimeOptions): "user" | "host_watchdog" {
	if (runtimeOptions.abortSource !== undefined) return runtimeOptions.abortSource;
	const reason = runtimeOptions.signal?.reason as unknown;
	if (reason === "host_watchdog") return "host_watchdog";
	if (typeof reason === "object" && reason !== null) {
		const source =
			(reason as { source?: unknown; abortSource?: unknown }).source ??
			(reason as { abortSource?: unknown }).abortSource;
		if (source === "host_watchdog") return "host_watchdog";
	}
	return "user";
}

export function abortCodeFromRuntimeOptions(
	runtimeOptions: RepoAuditRuntimeOptions,
): "USER_ABORTED" | "HOST_WATCHDOG_ABORTED" {
	return explicitAbortSource(runtimeOptions) === "host_watchdog" ? "HOST_WATCHDOG_ABORTED" : "USER_ABORTED";
}

function abortError(runtimeOptions: RepoAuditRuntimeOptions): RepoAuditError {
	return abortCodeFromRuntimeOptions(runtimeOptions) === "HOST_WATCHDOG_ABORTED"
		? new RepoAuditError("HOST_WATCHDOG_ABORTED", "RepoAudit was cancelled by the host watchdog.")
		: new RepoAuditError("USER_ABORTED", "RepoAudit was cancelled.");
}

export function processTerminationError(
	processResult: Pick<ProcessRunResult, "aborted" | "timedOut">,
	runtimeOptions: RepoAuditRuntimeOptions,
): RepoAuditError | null {
	if (processResult.aborted) return abortError(runtimeOptions);
	if (processResult.timedOut) {
		return new RepoAuditError("SCAN_TIMEOUT", "RepoAudit scan exceeded its configured timeout.");
	}
	return null;
}

function safeRelativeArtifact(root: string, candidate: string | null): string | null {
	if (candidate === null) return null;
	const relative = path.relative(root, candidate);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return relative.replaceAll("\\", "/");
}

async function appendExecutionLog(
	config: RepoAuditRuntimeConfig,
	result: RepoAuditResult,
	terminationSource: string | null,
	lockReleaseFailed = false,
): Promise<void> {
	if (!config.repoAuditRoot) return;
	try {
		const directory = path.join(config.repoAuditRoot, "log");
		await mkdir(directory, { recursive: true });
		const record = {
			runId: result.execution.runId,
			phase: "completed",
			status: result.status,
			durationMs: result.execution.durationMs,
			exitCode: result.execution.exitCode,
			terminationSource,
			timeoutSource:
				terminationSource === "plugin" || terminationSource === "host_watchdog" ? terminationSource : null,
			errorCode: result.error?.code ?? null,
			reportPath: safeRelativeArtifact(config.repoAuditRoot, result.reportPath),
			logPath: safeRelativeArtifact(config.repoAuditRoot, result.logPath),
			artifactIsolation: result.execution.artifactIsolation,
			lockReleaseFailed,
			lockReleaseErrorCode: lockReleaseFailed ? "LOCK_RELEASE_FAILED" : null,
			endedAt: result.execution.endedAt,
		};
		await appendFile(path.join(directory, "repoaudit-pi.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		// Execution logging is best effort and never changes the scan result.
	}
}

async function executeRepoAudit(
	options: RepoAuditRunOptions,
	runtimeOptions: RepoAuditRuntimeOptions,
): Promise<RepoAuditResult> {
	const runId = runtimeOptions.runId ?? createRepoAuditRunId();
	if (!/^run_[0-9a-f]{32}$/.test(runId)) {
		const config = fallbackRuntimeConfig();
		return failedResult(
			options,
			safeRequestedPath(options),
			baseExecution(runId, config, new Date()),
			new RepoAuditError("MODEL_CONFIGURATION_ERROR", "runId is invalid."),
		);
	}
	const startedAtDate = new Date();
	const startedAtMs = startedAtDate.getTime();
	let config: RepoAuditRuntimeConfig;
	try {
		config = createRuntimeConfig();
	} catch (error) {
		const fallbackConfig = fallbackRuntimeConfig();
		return failedResult(
			options,
			safeRequestedPath(options),
			baseExecution(runId, fallbackConfig, startedAtDate),
			asRepoAuditError(error),
		);
	}

	let repoPath = safeRequestedPath(options);
	let pythonVersion = "unknown";
	let processResult: ProcessRunResult | undefined;
	let artifacts: LocatedArtifacts | undefined;
	let finalResult!: RepoAuditResult;
	let terminationSource: string | null = null;
	let lockReleaseFailed = false;
	let fileLock: Awaited<ReturnType<typeof acquireRepoAuditFileLock>> | undefined;
	try {
		if (
			runtimeOptions.timeoutMs !== undefined &&
			(!Number.isSafeInteger(runtimeOptions.timeoutMs) || runtimeOptions.timeoutMs < 1_000)
		) {
			throw new RepoAuditError("MODEL_CONFIGURATION_ERROR", "timeoutMs must be an integer of at least 1000.");
		}
		emitProgress(runtimeOptions, runId, "waiting_for_lock", startedAtMs);
		fileLock = await acquireRepoAuditFileLock({
			directory: config.lockDirectory,
			runId,
			waitTimeoutMs: config.lockTimeoutMs,
			staleMs: config.lockStaleMs,
			heartbeatMs: config.heartbeatMs,
			...(runtimeOptions.signal === undefined ? {} : { signal: runtimeOptions.signal }),
		});
		emitProgress(runtimeOptions, runId, "preflight", startedAtMs);
		const preflight = await preflightRepoAudit(options, config);
		fileLock.assertOwned();
		repoPath = preflight.repoPath;
		pythonVersion = preflight.pythonVersion;
		const before = await snapshotArtifacts(options, repoPath, config);
		emitProgress(runtimeOptions, runId, "python_start", startedAtMs);
		const processSignal =
			runtimeOptions.signal === undefined
				? fileLock.signal
				: AbortSignal.any([runtimeOptions.signal, fileLock.signal]);
		processResult = await runProcess({
			command: config.pythonExecutable,
			args: buildRepoAuditArgs(options, config, repoPath, runId),
			cwd: config.repoAuditSrcDirectory,
			env: buildChildEnvironment(config),
			timeoutMs: runtimeOptions.timeoutMs ?? config.defaultTimeoutMs,
			terminationGraceMs: 1_000,
			onStdoutLine(line) {
				const phase = progressPhaseFromLine(line, runId);
				if (phase !== null) emitProgress(runtimeOptions, runId, phase, startedAtMs);
			},
			signal: processSignal,
		});
		if (fileLock.leaseError !== null) {
			terminationSource = "lock_lease_lost";
			throw fileLock.leaseError;
		}
		const terminationError = processTerminationError(processResult, runtimeOptions);
		if (processResult.timedOut) {
			terminationSource = "plugin";
		} else if (processResult.aborted) {
			terminationSource = explicitAbortSource(runtimeOptions) === "host_watchdog" ? "host_watchdog" : "user_abort";
		}
		if (terminationError !== null) throw terminationError;
		if (processResult.spawnError !== null) {
			const code = processResult.spawnError.code === "ENOENT" ? "PYTHON_NOT_FOUND" : "ANALYSIS_FAILED";
			throw new RepoAuditError(code, "RepoAudit Python process could not be started.", {
				cause: processResult.spawnError,
			});
		}
		if (processResult.exitCode !== 0) {
			throw new RepoAuditError("ANALYSIS_FAILED", "RepoAudit Python process exited unsuccessfully.");
		}
		emitProgress(runtimeOptions, runId, "artifact_validation", startedAtMs);
		const after = await snapshotArtifacts(options, repoPath, config);
		fileLock.assertOwned();
		artifacts = await locateArtifacts(before, after, config, runId);
		const execution = executionFromProcess(runId, config, pythonVersion, processResult, artifacts);
		const parsed = await parseRunArtifacts(artifacts, processResult.stdout, options.bugType);
		fileLock.assertOwned();
		finalResult = {
			status: parsed.status,
			tool: "repoaudit",
			bugType: options.bugType,
			language: options.language,
			repoPath,
			findingCount: parsed.findings.length,
			findings: parsed.findings,
			reportPath: artifacts.reportPath,
			logPath: artifacts.logPath,
			execution,
		};
	} catch (error) {
		let normalized = asRepoAuditError(error);
		if (normalized.code === "USER_ABORTED" && runtimeOptions.signal?.aborted) normalized = abortError(runtimeOptions);
		if (normalized.code === "HOST_WATCHDOG_ABORTED") terminationSource ??= "host_watchdog";
		if (normalized.code === "USER_ABORTED") terminationSource ??= "user_abort";
		if (normalized.code === "LOCK_LEASE_LOST") terminationSource = "lock_lease_lost";
		const execution =
			processResult === undefined
				? baseExecution(runId, config, startedAtDate)
				: executionFromProcess(runId, config, pythonVersion, processResult, artifacts);
		finalResult = failedResult(options, repoPath, execution, normalized, artifacts);
	} finally {
		if (fileLock !== undefined) {
			try {
				await fileLock.release();
			} catch {
				lockReleaseFailed = true;
			}
			if (fileLock.leaseError !== null && finalResult.status !== "failed") {
				terminationSource = "lock_lease_lost";
				finalResult = failedResult(options, repoPath, finalResult.execution, fileLock.leaseError, artifacts);
			}
		}
	}
	emitProgress(runtimeOptions, runId, "completed", startedAtMs);
	await appendExecutionLog(config, finalResult, terminationSource, lockReleaseFailed);
	return finalResult;
}

export async function runRepoAudit(
	options: RepoAuditRunOptions,
	runtimeOptions: RepoAuditRuntimeOptions = {},
): Promise<RepoAuditResult> {
	return withRepoAuditLock(() => executeRepoAudit(options, runtimeOptions), runtimeOptions.signal).catch(
		async (error: unknown) => {
			let config: RepoAuditRuntimeConfig;
			try {
				config = createRuntimeConfig();
			} catch {
				config = fallbackRuntimeConfig();
			}
			const startedAt = new Date();
			const runId = runtimeOptions.runId ?? createRepoAuditRunId();
			const normalized = runtimeOptions.signal?.aborted ? abortError(runtimeOptions) : asRepoAuditError(error);
			const result = failedResult(
				options,
				safeRequestedPath(options),
				baseExecution(runId, config, startedAt),
				normalized,
			);
			const terminationSource =
				normalized.code === "HOST_WATCHDOG_ABORTED"
					? "host_watchdog"
					: normalized.code === "USER_ABORTED"
						? "user_abort"
						: null;
			await appendExecutionLog(config, result, terminationSource);
			return result;
		},
	);
}
