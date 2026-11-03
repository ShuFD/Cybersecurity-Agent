import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExecutionModeSpec, resolveExecutionMode } from "./execution-mode.ts";

export type PermissionMode = "default" | "acceptEdits" | "dontAsk" | "bypassPermissions" | "plan";
export type ThinkingMode = "adaptive" | "enabled" | "disabled";
export type PlanningMode = "off" | "shadow" | "active";
export type PlanningObserverMode = "off" | "report" | "guidance";

export interface McpHttpServerConfig {
	transport: "http";
	url: string;
	headers: Record<string, string>;
	timeoutMs: number;
	protocolVersion: string;
}

export interface McpStdioServerConfig {
	transport: "stdio";
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
	timeoutMs: number;
	protocolVersion: string;
}

export type McpServerConfig = McpHttpServerConfig | McpStdioServerConfig;

export interface JudgeConfig {
	enabled: boolean;
	everyNTurns: number;
	maxHistoryMessages: number;
	modelProfile?: string;
}

export interface PlanningConfig {
	mode: PlanningMode;
	/** Missing/old configuration retains the progressive engine. */
	engine?: "progressive" | "cairn" | "hypothesis" | "artex";
	/** Maximum active PLAN_MULTI Executors within this Bridge process. */
	globalExecutorCapacity?: number;
	maxSteps: number;
	maxTasks: number;
	leaseTtlMs: number;
	taskTimeoutMs: number;
	maxEvidenceBytes: number;
	executorContextBytes: number;
	evidenceCatalogEnabled: boolean;
	observerMode: PlanningObserverMode;
	taskGranularityPromptEnabled: boolean;
}

export type RegistryKind = "mcpServers" | "skills" | "tools" | "agents";

export interface RegistryConfig {
	mcpServers: Record<string, boolean>;
	skills: Record<string, boolean>;
	tools: Record<string, boolean>;
	agents: Record<string, boolean>;
}

export interface SecHeurConfig {
	projectRoot: string;
	stateDir: string;
	agentDir: string;
	legacyRoot: string;
	pythonExecutable: string;
	permissionMode: PermissionMode;
	agentFirstOutputTimeoutMs: number;
	agentOutputIdleTimeoutMs: number;
	maxTurns?: number;
	maxCost?: number;
	thinkingMode: ThinkingMode;
	thinkingBudget?: number;
	attemptDedupEnabled: boolean;
	knowledgeBaseEnabled: boolean;
	mcpServers: Record<string, McpServerConfig>;
	skillPaths: string[];
	systemPromptPath: string;
	judge: JudgeConfig;
	executionMode: ExecutionModeSpec;
	planning: PlanningConfig;
	registry: RegistryConfig;
}

export interface LoadSecHeurConfigOptions {
	planningEngine?: "progressive" | "cairn" | "hypothesis" | "artex";
	projectRoot?: string;
	stateDir?: string;
	legacyRoot?: string;
	env?: NodeJS.ProcessEnv;
	/** Optional per-runtime override for the resolved execution mode. */
	executionMode?: unknown;
	/** Optional per-runtime capacity override (used by PLAN_MULTI validation). */
	executionCapacity?: unknown;
}

type JsonObject = Record<string, unknown>;

const MCP_PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_MCP_TIMEOUT_MS = 15_000;
const MAX_TIMER_TIMEOUT_SECONDS = 2_147_483;
const PERMISSION_MODES = new Set<PermissionMode>(["default", "acceptEdits", "dontAsk", "bypassPermissions", "plan"]);
const THINKING_MODES = new Set<ThinkingMode>(["adaptive", "enabled", "disabled"]);
function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string): JsonObject | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isJsonObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstConfigured(...values: unknown[]): unknown {
	return values.find(
		(value) => value !== undefined && value !== null && (typeof value !== "string" || value.trim() !== ""),
	);
}

function asPositiveInteger(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function asBoundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, asPositiveInteger(value, fallback)));
}

function asOptionalPositiveNumber(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function asOptionalPositiveInteger(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function asTurnLimit(value: unknown, fallback: number): number | undefined {
	if (value === 0 || value === "0") return undefined;
	if (value === undefined || value === null || value === "") return fallback;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stringRecord(value: unknown): Record<string, string> {
	if (!isJsonObject(value)) return {};
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, item]) =>
			typeof item === "string" || typeof item === "number" || typeof item === "boolean" ? [[key, String(item)]] : [],
		),
	);
}

function booleanRecord(value: unknown): Record<string, boolean> {
	if (!isJsonObject(value)) return {};
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, item]) => {
			if (typeof item === "boolean") return [[key, item]];
			if (typeof item !== "string") return [];
			return [[key, !["0", "false", "no", "off", "disabled"].includes(item.toLowerCase())]];
		}),
	);
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.flatMap((item) => (typeof item === "string" ? [item] : [])) : [];
}

function configuredPaths(value: unknown, base: string): string[] {
	const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/u) : [];
	return items.flatMap((item) => {
		if (typeof item !== "string") return [];
		const text = item.trim();
		if (!text) return [];
		const expanded = text === "~" ? homedir() : /^~[/\\]/u.test(text) ? join(homedir(), text.slice(2)) : text;
		return [isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded)];
	});
}

function resolveConfigPath(path: string | undefined, base: string): string | undefined {
	if (!path) return undefined;
	return isAbsolute(path) ? path : resolve(base, path);
}

function parseMcpServer(raw: unknown, projectRoot: string, defaultTimeoutMs: number): McpServerConfig | undefined {
	if (!isJsonObject(raw)) return undefined;
	const timeoutMs = Math.round(
		1000 *
			(typeof raw.timeout === "number" || typeof raw.timeout === "string"
				? Number(raw.timeout)
				: defaultTimeoutMs / 1000),
	);
	const normalizedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs;
	const protocolVersion = asString(raw.protocolVersion) ?? asString(raw.protocol_version) ?? MCP_PROTOCOL_VERSION;
	const url = asString(raw.url);
	const transport = asString(raw.transport)?.toLowerCase().replaceAll("-", "_");
	if (url || transport === "http" || transport === "streamable_http" || transport === "sse") {
		if (!url) return undefined;
		return {
			transport: "http",
			url,
			headers: stringRecord(raw.headers),
			timeoutMs: normalizedTimeoutMs,
			protocolVersion,
		};
	}

	const command = asString(raw.command);
	if (!command) return undefined;
	return {
		transport: "stdio",
		command,
		args: stringArray(raw.args),
		env: stringRecord(raw.env),
		cwd: resolveConfigPath(asString(raw.cwd), projectRoot),
		timeoutMs: normalizedTimeoutMs,
		protocolVersion,
	};
}

function mergeMcpFile(
	path: string,
	projectRoot: string,
	target: Record<string, McpServerConfig>,
	defaultTimeoutMs: number,
): number {
	const raw = readJsonObject(path);
	if (!raw) return defaultTimeoutMs;
	const mcpOptions = isJsonObject(raw.mcp) ? raw.mcp : undefined;
	const timeoutSeconds = mcpOptions?.timeout ?? raw.mcpTimeout;
	const nextDefaultTimeoutMs =
		timeoutSeconds === undefined
			? defaultTimeoutMs
			: asPositiveInteger(Number(timeoutSeconds) * 1000, defaultTimeoutMs);
	const servers = isJsonObject(raw.mcpServers) ? raw.mcpServers : raw;
	for (const [name, value] of Object.entries(servers)) {
		const parsed = parseMcpServer(value, projectRoot, nextDefaultTimeoutMs);
		if (parsed) target[name] = parsed;
	}
	return nextDefaultTimeoutMs;
}

function parsePermissionMode(value: unknown, fallback: PermissionMode): PermissionMode {
	return typeof value === "string" && PERMISSION_MODES.has(value as PermissionMode)
		? (value as PermissionMode)
		: fallback;
}

function parseThinkingMode(value: unknown): ThinkingMode {
	return typeof value === "string" && THINKING_MODES.has(value as ThinkingMode) ? (value as ThinkingMode) : "adaptive";
}

function defaultLegacyRoot(): string {
	const moduleDirectory = dirname(fileURLToPath(import.meta.url));
	const bundled = join(moduleDirectory, "legacy");
	return existsSync(join(bundled, "secheur_pi_bridge.py")) ? bundled : resolve(moduleDirectory, "../../../legacy");
}

function executableFile(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function executableOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
	const pathValue = env.PATH ?? env.Path ?? env.path;
	if (!pathValue) return undefined;
	const extensions =
		process.platform === "win32"
			? (env.PATHEXT ?? ".EXE;.CMD;.BAT")
					.split(delimiter)
					.flatMap((extension) => [extension, extension.toLowerCase()])
			: [""];
	for (const directory of pathValue.split(delimiter).filter(Boolean)) {
		for (const extension of extensions) {
			const candidate = join(directory, `${command}${extension}`);
			if (executableFile(candidate)) return candidate;
		}
	}
	return undefined;
}

function defaultPythonExecutable(
	stateDir: string,
	projectRoot: string,
	legacyRoot: string,
	env: NodeJS.ProcessEnv,
): string {
	const localCandidates =
		process.platform === "win32"
			? [
					join(stateDir, "python", "Scripts", "python.exe"),
					join(projectRoot, ".venv", "Scripts", "python.exe"),
					join(legacyRoot, ".venv", "Scripts", "python.exe"),
				]
			: [
					join(stateDir, "python", "bin", "python"),
					join(projectRoot, ".venv", "bin", "python"),
					join(legacyRoot, ".venv", "bin", "python"),
				];
	for (const candidate of localCandidates) {
		if (executableFile(candidate)) return candidate;
	}
	const commands =
		process.platform === "win32"
			? ["python"]
			: ["python3.12", "python3.11", "python3.13", "python3.10", "python3", "python"];
	for (const command of commands) {
		const executable = executableOnPath(command, env);
		if (executable) return executable;
	}
	return process.platform === "win32" ? "python" : "python3";
}

/**
 * Single source of truth for the SecHeur state directory.
 *
 * Every component that reads or writes persisted state (desktop-config.json,
 * settings.json, bridge-state.json, api-profiles.json, ...) must resolve it
 * through here. `SECHEUR_CONFIG_DIR` deliberately overrides the project-local
 * `.secheur-agent` directory so one deployment can point the whole agent at a
 * shared profile; anything that resolves the path on its own silently splits
 * the state in two and the UI ends up editing a file the runtime never reads.
 */
export function resolveSecHeurStateDir(
	projectRoot: string,
	env: NodeJS.ProcessEnv = process.env,
	explicitStateDir?: string,
): string {
	return resolve(explicitStateDir ?? env.SECHEUR_CONFIG_DIR ?? join(projectRoot, ".secheur-agent"));
}

export function loadSecHeurConfig(options: LoadSecHeurConfigOptions = {}): SecHeurConfig {
	const env = options.env ?? process.env;
	const projectRoot = resolve(options.projectRoot ?? process.cwd());
	const stateDir = resolveSecHeurStateDir(projectRoot, env, options.stateDir);
	const legacyRoot = resolve(options.legacyRoot ?? env.SECHEUR_LEGACY_ROOT ?? defaultLegacyRoot());
	const desktopConfig = readJsonObject(join(stateDir, "desktop-config.json")) ?? {};
	const registryState = readJsonObject(join(stateDir, "settings.json")) ?? {};
	const permissionMode = parsePermissionMode(
		env.SECHEUR_PERMISSION_MODE,
		parsePermissionMode(desktopConfig.permissionMode, "default"),
	);
	const agentFirstOutputTimeoutSeconds = asBoundedInteger(
		desktopConfig.agentFirstOutputTimeoutSeconds,
		asBoundedInteger(env.SECHEUR_AGENT_FIRST_OUTPUT_TIMEOUT, 120, 1, MAX_TIMER_TIMEOUT_SECONDS),
		1,
		MAX_TIMER_TIMEOUT_SECONDS,
	);
	const agentOutputIdleTimeoutSeconds = asBoundedInteger(
		desktopConfig.agentOutputIdleTimeoutSeconds,
		asBoundedInteger(env.SECHEUR_AGENT_OUTPUT_IDLE_TIMEOUT, 600, 1, MAX_TIMER_TIMEOUT_SECONDS),
		1,
		MAX_TIMER_TIMEOUT_SECONDS,
	);

	const mcpServers: Record<string, McpServerConfig> = {};
	let mcpTimeoutMs = DEFAULT_MCP_TIMEOUT_MS;
	for (const path of [
		join(projectRoot, "settings.json"),
		join(projectRoot, "settings.local.json"),
		join(stateDir, "settings.json"),
		join(stateDir, "settings.local.json"),
		join(stateDir, "mcp.json"),
		join(projectRoot, ".mcp.json"),
	]) {
		mcpTimeoutMs = mergeMcpFile(path, projectRoot, mcpServers, mcpTimeoutMs);
	}

	const languageSuffix = (env.SECHEUR_LANG ?? "zh").toLowerCase().startsWith("en") ? "_en" : "";
	const judgeRaw = isJsonObject(desktopConfig.judge) ? desktopConfig.judge : {};
	const planningRaw = isJsonObject(desktopConfig.planning) ? desktopConfig.planning : {};
	const maxEvidenceBytes = asBoundedInteger(
		planningRaw.maxEvidenceBytes ?? planningRaw.max_evidence_bytes,
		16_384,
		1_024,
		1_048_576,
	);
	const configuredObserverMode = planningRaw.observerMode ?? planningRaw.observer_mode;
	const configuredPlanningMode = firstConfigured(env.SECHEUR_PLANNING_MODE, planningRaw.mode);
	const configuredExecutionValue = firstConfigured(
		options.executionMode,
		env.SECHEUR_EXECUTION_MODE,
		planningRaw.executionMode,
		desktopConfig.executionMode,
	);
	const configuredExecutionObject = isJsonObject(configuredExecutionValue) ? configuredExecutionValue : undefined;
	const executionMode = resolveExecutionMode({
		mode: configuredExecutionObject?.mode ?? configuredExecutionValue,
		legacyPlanningMode: configuredPlanningMode,
		planningEnabled: asOptionalBoolean(firstConfigured(planningRaw.enabled, desktopConfig.planningEnabled)),
		capacity:
			options.executionCapacity ??
			env.SECHEUR_EXECUTION_CAPACITY ??
			configuredExecutionObject?.capacity ??
			planningRaw.capacity ??
			desktopConfig.executionCapacity,
	});
	const judgeModelProfile = asString(judgeRaw.model_profile);
	const customSkillPaths = configuredPaths(desktopConfig.customSkillDirectories, projectRoot);
	return {
		projectRoot,
		stateDir,
		agentDir: resolve(env.SECHEUR_AGENT_DIR ?? join(stateDir, "pi")),
		legacyRoot,
		pythonExecutable: env.SECHEUR_PYTHON?.trim() || defaultPythonExecutable(stateDir, projectRoot, legacyRoot, env),
		permissionMode,
		agentFirstOutputTimeoutMs: agentFirstOutputTimeoutSeconds * 1000,
		agentOutputIdleTimeoutMs: agentOutputIdleTimeoutSeconds * 1000,
		maxTurns: asTurnLimit(desktopConfig.maxTurns, 80),
		maxCost: asOptionalPositiveNumber(desktopConfig.maxCost),
		thinkingMode: parseThinkingMode(desktopConfig.thinkingMode),
		thinkingBudget: asOptionalPositiveInteger(desktopConfig.thinkingBudget),
		attemptDedupEnabled: desktopConfig.attemptDedupEnabled === true,
		knowledgeBaseEnabled:
			asOptionalBoolean(env.SECHEUR_KNOWLEDGE_BASE_ENABLED) ??
			asOptionalBoolean(desktopConfig.knowledgeBaseEnabled) ??
			false,
		mcpServers,
		skillPaths: [
			...new Set([
				join(stateDir, "skills"),
				join(projectRoot, ".agents", "skills"),
				join(projectRoot, "skill"),
				join(projectRoot, "skills"),
				...customSkillPaths,
				join(legacyRoot, ".agents", "skills"),
				join(legacyRoot, "skill"),
				join(legacyRoot, "skills"),
			]),
		],
		systemPromptPath: join(legacyRoot, "assets", `sys_prompt${languageSuffix}.txt`),
		judge: {
			enabled: judgeRaw.enabled !== false,
			everyNTurns: asBoundedInteger(judgeRaw.every_n_turns, 5, 1, 50),
			maxHistoryMessages: asBoundedInteger(judgeRaw.max_history_messages, 8, 2, 20),
			...(judgeModelProfile ? { modelProfile: judgeModelProfile } : {}),
		},
		executionMode,
		planning: {
			engine:
				(options.planningEngine ?? planningRaw.engine) === "artex"
					? "artex"
					: (options.planningEngine ?? planningRaw.engine) === "hypothesis"
						? "hypothesis"
						: (options.planningEngine ?? planningRaw.engine) === "cairn"
							? "cairn"
							: "progressive",
			// Preserve the old field for persisted config/UI compatibility. Runtime
			// routing consumes executionMode above as the single source of truth.
			mode: executionMode.legacyPlanningMode,
			// Retain explicit legacy values for config compatibility; scheduling ignores them.
			globalExecutorCapacity:
				(planningRaw.globalExecutorCapacity ?? planningRaw.global_executor_capacity) === undefined
					? undefined
					: asBoundedInteger(planningRaw.globalExecutorCapacity ?? planningRaw.global_executor_capacity, 2, 1, 64),
			maxSteps: asBoundedInteger(planningRaw.maxSteps ?? planningRaw.max_steps, 12, 1, 100),
			maxTasks: asBoundedInteger(planningRaw.maxTasks ?? planningRaw.max_tasks, 48, 1, 500),
			leaseTtlMs:
				asBoundedInteger(planningRaw.leaseTtlSeconds ?? planningRaw.lease_ttl_seconds, 900, 5, 86_400) * 1000,
			taskTimeoutMs:
				asBoundedInteger(planningRaw.taskTimeoutSeconds ?? planningRaw.task_timeout_seconds, 600, 5, 86_400) * 1000,
			maxEvidenceBytes,
			executorContextBytes: asBoundedInteger(
				planningRaw.executorContextBytes ?? planningRaw.executor_context_bytes,
				maxEvidenceBytes,
				1_024,
				1_048_576,
			),
			evidenceCatalogEnabled: (planningRaw.evidenceCatalogEnabled ?? planningRaw.evidence_catalog_enabled) !== false,
			observerMode:
				configuredObserverMode === "report" || configuredObserverMode === "guidance"
					? configuredObserverMode
					: "off",
			taskGranularityPromptEnabled:
				(planningRaw.taskGranularityPromptEnabled ?? planningRaw.task_granularity_prompt_enabled) === true,
		},
		registry: {
			mcpServers: booleanRecord(registryState.mcpServers),
			skills: booleanRecord(registryState.skills),
			tools: booleanRecord(registryState.tools),
			agents: booleanRecord(registryState.agents),
		},
	};
}

export function isRegistryResourceEnabled(config: SecHeurConfig, kind: RegistryKind, name: string): boolean {
	return config.registry[kind][name] !== false;
}

export function disabledRegistryNames(config: SecHeurConfig, kind: RegistryKind): string[] {
	const disabled = new Set(
		Object.entries(config.registry[kind]).flatMap(([name, isEnabled]) => (isEnabled ? [] : [name])),
	);
	if (kind === "tools" && !config.knowledgeBaseEnabled) disabled.add("attack_memory_search");
	if (kind === "tools" && config.executionMode.legacyPlanningMode === "active") {
		for (const name of ["plan_expand", "plan_revise", "plan_status"]) disabled.add(name);
	}
	return [...disabled].sort();
}
