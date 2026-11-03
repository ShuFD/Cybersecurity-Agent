import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { RepoAuditBugType, RepoAuditLanguage, RepoAuditRunOptions } from "./contracts.ts";
import { RepoAuditError } from "./errors.ts";

export const RUNTIME_ENVIRONMENT_NAMES = {
	repoAuditRoot: "REPOAUDIT_ROOT",
	requireExplicitRoot: "REPOAUDIT_REQUIRE_EXPLICIT_ROOT",
	pythonExecutable: "REPOAUDIT_PYTHON",
	modelName: "REPOAUDIT_MODEL",
	timeoutMs: "REPOAUDIT_TIMEOUT_MS",
	requireApiKey: "REPOAUDIT_REQUIRE_API_KEY",
	maxSymbolicWorkers: "REPOAUDIT_MAX_SYMBOLIC_WORKERS",
	maxNeuralWorkers: "REPOAUDIT_MAX_NEURAL_WORKERS",
	lockDirectory: "REPOAUDIT_LOCK_DIR",
	lockTimeoutMs: "REPOAUDIT_LOCK_TIMEOUT_MS",
	lockStaleMs: "REPOAUDIT_LOCK_STALE_MS",
	heartbeatMs: "REPOAUDIT_HEARTBEAT_MS",
} as const;

export const RUNTIME_DEFAULTS = {
	timeoutMs: 30 * 60 * 1000,
	maxSymbolicWorkers: 4,
	maxNeuralWorkers: 1,
	lockTimeoutMs: 5 * 60 * 1000,
	lockStaleMs: 2 * 60 * 1000,
	heartbeatMs: 25 * 1000,
} as const;

const NUMERIC_RANGES = {
	timeoutMs: [1_000, 24 * 60 * 60 * 1000],
	maxSymbolicWorkers: [1, 32],
	maxNeuralWorkers: [1, 8],
	lockTimeoutMs: [1_000, 60 * 60 * 1000],
	lockStaleMs: [30_000, 24 * 60 * 60 * 1000],
	heartbeatMs: [1_000, 5 * 60 * 1000],
} as const;

export const SOURCE_EXTENSIONS: Record<RepoAuditLanguage, readonly string[]> = {
	Cpp: [".cpp", ".cc", ".hpp", ".c", ".h"],
	Java: [".java"],
	Python: [".py"],
	Go: [".go"],
};

export const SUPPORTED_COMBINATIONS: Record<RepoAuditLanguage, readonly RepoAuditBugType[]> = {
	Cpp: ["MLK", "NPD", "UAF"],
	Java: ["NPD"],
	Python: ["NPD"],
	Go: ["NPD"],
};

export interface RepoAuditRuntimeConfig {
	repoAuditRoot: string;
	rootSource: "explicit" | "inferred";
	repoAuditSrcDirectory: string;
	repoAuditEntryPoint: string;
	pythonExecutable: string;
	treeSitterLibrary: string;
	runsDirectory: string;
	lockDirectory: string;
	defaultTimeoutMs: number;
	lockTimeoutMs: number;
	lockStaleMs: number;
	heartbeatMs: number;
	modelName: string;
	temperature: number;
	callDepth: number;
	maxSymbolicWorkers: number;
	maxNeuralWorkers: number;
	apiKeyEnvironmentName: string | null;
	requireApiKey: boolean;
	environment: NodeJS.ProcessEnv;
}

function findRootFrom(startDirectory: string): string | null {
	let current = path.resolve(startDirectory);
	for (let depth = 0; depth < 10; depth += 1) {
		if (existsSync(path.join(current, "src", "repoaudit.py"))) return current;
		const vendoredRoot = path.join(current, "vendor", "repoaudit");
		if (existsSync(path.join(vendoredRoot, "src", "repoaudit.py"))) return vendoredRoot;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
}

function inferRepoAuditRoot(moduleDirectory: string): string {
	for (const start of [process.cwd(), moduleDirectory]) {
		const found = findRootFrom(start);
		if (found !== null) return found;
	}
	throw new RepoAuditError("RUNTIME_NOT_FOUND", "RepoAudit runtime root could not be inferred.");
}

function readBoundedPositiveInteger(
	value: string | undefined,
	fallback: number,
	name: string,
	range: readonly [number, number],
): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < range[0] || parsed > range[1]) {
		throw new RepoAuditError(
			"MODEL_CONFIGURATION_ERROR",
			`${name} must be an integer between ${range[0]} and ${range[1]}.`,
		);
	}
	return parsed;
}

export function apiKeyNameForModel(modelName: string): string | null {
	const normalized = modelName.toLowerCase();
	if (normalized.includes("claude")) return "ANTHROPIC_API_KEY";
	if (/\b(gpt|o1|o3|o4|chatgpt)/.test(normalized)) return "OPENAI_API_KEY";
	if (normalized.includes("deepseek")) return "DEEPSEEK_API_KEY2";
	if (normalized.includes("gemini")) return "GOOGLE_API_KEY";
	return null;
}

export function createRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RepoAuditRuntimeConfig {
	environment = { ...environment };
	// Explicit audit model settings take precedence over the host's default provider.
	if (!environment.REPOAUDIT_MODEL && environment.SECHEUR_AGENT_DIR) {
		const directory = environment.SECHEUR_AGENT_DIR;
		try {
			const settings = JSON.parse(readFileSync(path.join(directory, "settings.json"), "utf8"));
			const models = JSON.parse(readFileSync(path.join(directory, "models.json"), "utf8"));
			const provider = models.providers?.[settings.defaultProvider];
			if (provider?.api !== "openai-completions" || !provider.baseUrl || !settings.defaultModel) {
				throw new Error("unsupported host provider");
			}
			const auth = JSON.parse(readFileSync(path.join(directory, "auth.json"), "utf8"));
			const key = auth[settings.defaultProvider]?.key;
			if (typeof key !== "string" || !key || key.startsWith("!")) throw new Error("missing host credential");
			environment.REPOAUDIT_MODEL = settings.defaultModel;
			environment.REPOAUDIT_OPENAI_BASE_URL = provider.baseUrl;
			environment.OPENAI_API_KEY = key;
		} catch {
			throw new RepoAuditError("MODEL_CONFIGURATION_ERROR", "Cannot reuse host model: expected an openai-completions default provider and stored API-key credential in SECHEUR_AGENT_DIR.");
		}
	}
	const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
	const configuredRoot = environment[RUNTIME_ENVIRONMENT_NAMES.repoAuditRoot]?.trim();
	const strictRoot = environment[RUNTIME_ENVIRONMENT_NAMES.requireExplicitRoot]?.trim() === "1";
	if (!configuredRoot && strictRoot) {
		throw new RepoAuditError("RUNTIME_NOT_FOUND", "REPOAUDIT_ROOT is required when explicit-root mode is enabled.");
	}
	const repoAuditRoot = configuredRoot ? path.resolve(configuredRoot) : inferRepoAuditRoot(moduleDirectory);
	const defaultPython =
		process.platform === "win32"
			? path.join(repoAuditRoot, ".venv", "Scripts", "python.exe")
			: path.join(repoAuditRoot, ".venv", "bin", "python");
	const modelName = environment[RUNTIME_ENVIRONMENT_NAMES.modelName]?.trim() || "claude-3.7";
	if (
		modelName === "." ||
		modelName === ".." ||
		modelName.includes("/") ||
		modelName.includes("\\") ||
		modelName.includes("\0")
	) {
		throw new RepoAuditError("MODEL_CONFIGURATION_ERROR", "REPOAUDIT_MODEL must be a single safe path component.");
	}
	const lockDirectoryValue = environment[RUNTIME_ENVIRONMENT_NAMES.lockDirectory]?.trim();

	const config: RepoAuditRuntimeConfig = {
		repoAuditRoot,
		rootSource: configuredRoot ? "explicit" : "inferred",
		repoAuditSrcDirectory: path.join(repoAuditRoot, "src"),
		repoAuditEntryPoint: path.join(repoAuditRoot, "src", "repoaudit.py"),
		pythonExecutable: path.resolve(environment[RUNTIME_ENVIRONMENT_NAMES.pythonExecutable]?.trim() || defaultPython),
		treeSitterLibrary: path.join(repoAuditRoot, "lib", "build", "my-languages.so"),
		runsDirectory: path.join(repoAuditRoot, "runs"),
		lockDirectory: path.resolve(lockDirectoryValue || path.join(repoAuditRoot, "lock")),
		defaultTimeoutMs: readBoundedPositiveInteger(
			environment[RUNTIME_ENVIRONMENT_NAMES.timeoutMs],
			RUNTIME_DEFAULTS.timeoutMs,
			RUNTIME_ENVIRONMENT_NAMES.timeoutMs,
			NUMERIC_RANGES.timeoutMs,
		),
		lockTimeoutMs: readBoundedPositiveInteger(
			environment[RUNTIME_ENVIRONMENT_NAMES.lockTimeoutMs],
			RUNTIME_DEFAULTS.lockTimeoutMs,
			RUNTIME_ENVIRONMENT_NAMES.lockTimeoutMs,
			NUMERIC_RANGES.lockTimeoutMs,
		),
		lockStaleMs: readBoundedPositiveInteger(
			environment[RUNTIME_ENVIRONMENT_NAMES.lockStaleMs],
			RUNTIME_DEFAULTS.lockStaleMs,
			RUNTIME_ENVIRONMENT_NAMES.lockStaleMs,
			NUMERIC_RANGES.lockStaleMs,
		),
		heartbeatMs: readBoundedPositiveInteger(
			environment[RUNTIME_ENVIRONMENT_NAMES.heartbeatMs],
			RUNTIME_DEFAULTS.heartbeatMs,
			RUNTIME_ENVIRONMENT_NAMES.heartbeatMs,
			NUMERIC_RANGES.heartbeatMs,
		),
		modelName,
		temperature: 0,
		callDepth: 3,
		maxSymbolicWorkers: readBoundedPositiveInteger(
			environment[RUNTIME_ENVIRONMENT_NAMES.maxSymbolicWorkers],
			RUNTIME_DEFAULTS.maxSymbolicWorkers,
			RUNTIME_ENVIRONMENT_NAMES.maxSymbolicWorkers,
			NUMERIC_RANGES.maxSymbolicWorkers,
		),
		maxNeuralWorkers: readBoundedPositiveInteger(
			environment[RUNTIME_ENVIRONMENT_NAMES.maxNeuralWorkers],
			RUNTIME_DEFAULTS.maxNeuralWorkers,
			RUNTIME_ENVIRONMENT_NAMES.maxNeuralWorkers,
			NUMERIC_RANGES.maxNeuralWorkers,
		),
		apiKeyEnvironmentName: environment.REPOAUDIT_OPENAI_BASE_URL ? "OPENAI_API_KEY" : apiKeyNameForModel(modelName),
		requireApiKey: environment[RUNTIME_ENVIRONMENT_NAMES.requireApiKey]?.trim() !== "0",
		environment,
	};
	if (config.heartbeatMs >= config.lockStaleMs) {
		throw new RepoAuditError(
			"MODEL_CONFIGURATION_ERROR",
			"REPOAUDIT_HEARTBEAT_MS must be less than REPOAUDIT_LOCK_STALE_MS.",
		);
	}
	return config;
}

export function buildRepoAuditArgs(
	options: RepoAuditRunOptions,
	config: RepoAuditRuntimeConfig,
	canonicalRepoPath = options.repoPath,
	runId?: string,
): string[] {
	const projectPathArgument =
		process.platform === "win32" ? canonicalRepoPath.replaceAll("\\", "/") : canonicalRepoPath;
	const args = [
		"-u",
		config.repoAuditEntryPoint,
		"--scan-type",
		"dfbscan",
		"--project-path",
		projectPathArgument,
		"--language",
		options.language,
		"--model-name",
		config.modelName,
		"--temperature",
		String(config.temperature),
		"--call-depth",
		String(config.callDepth),
		"--max-symbolic-workers",
		String(config.maxSymbolicWorkers),
		"--max-neural-workers",
		String(config.maxNeuralWorkers),
		"--bug-type",
		options.bugType,
	];
	if (runId !== undefined) args.push("--run-id", runId);
	if (options.bugType !== "MLK") args.push("--is-reachable");
	return args;
}

const CHILD_ENVIRONMENT_ALLOWLIST = [
	"PATH",
	"Path",
	"SystemRoot",
	"WINDIR",
	"TEMP",
	"TMP",
	"HOME",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"LANG",
	"LC_ALL",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"SSL_CERT_FILE",
	"REQUESTS_CA_BUNDLE",
] as const;

export function buildChildEnvironment(config: RepoAuditRuntimeConfig): NodeJS.ProcessEnv {
	const childEnvironment: NodeJS.ProcessEnv = {
		PYTHONIOENCODING: "utf-8",
		PYTHONUTF8: "1",
		REPOAUDIT_RUNS_ROOT: config.runsDirectory,
		...(config.environment.REPOAUDIT_OPENAI_BASE_URL
			? { REPOAUDIT_OPENAI_BASE_URL: config.environment.REPOAUDIT_OPENAI_BASE_URL }
			: {}),
	};
	for (const name of CHILD_ENVIRONMENT_ALLOWLIST) {
		const value = config.environment[name];
		if (value !== undefined) childEnvironment[name] = value;
	}
	if (config.apiKeyEnvironmentName !== null) {
		const secret = config.environment[config.apiKeyEnvironmentName];
		if (secret !== undefined) childEnvironment[config.apiKeyEnvironmentName] = secret;
	}
	return childEnvironment;
}
