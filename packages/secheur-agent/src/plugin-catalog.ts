import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SecHeurConfig } from "./config.ts";
import { resolveExecutionMode } from "./execution-mode.ts";
import { listPiPlugins, type PiPluginDiagnostic, type PiPluginInfo } from "./pi-plugins.ts";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

interface BuiltinDescriptor {
	id: string;
	name: string;
	description: string;
	category: string;
	files: string[];
	required?: boolean;
	requires?: string[];
	configKey?: "judge" | "memory" | "planning" | "legacyPlanning";
	capabilities: string[];
}

export interface UnifiedPluginCatalogItem {
	key: string;
	id: string;
	kind: "builtin" | "pi";
	name: string;
	description: string;
	category: string;
	version?: string;
	configuredEnabled: boolean;
	effectiveEnabled: boolean;
	available: boolean;
	required: boolean;
	mutable: boolean;
	requires: string[];
	blockedBy: string[];
	reason: string;
	capabilities: string[];
	actions: { toggle: boolean; update: boolean; remove: boolean; open: boolean };
	[sourceProperty: string]: unknown;
}

export interface UnifiedPluginCatalog {
	plugins: UnifiedPluginCatalogItem[];
	diagnostics: PiPluginDiagnostic[];
	counts: { total: number; builtin: number; external: number; enabled: number };
	settingsPaths: { internal: string; user: string; project: string };
}

const BUILTIN_COMPONENTS: BuiltinDescriptor[] = [
	{
		id: "session-runtime",
		name: "会话运行时",
		description: "创建、恢复并驱动 Agent 会话，是其他内置组件的基础。",
		category: "核心",
		required: true,
		files: ["runtime.js", "pi-session-host.js", "session-registry.js"],
		capabilities: ["会话生命周期", "上下文恢复", "运行时重载"],
	},
	{
		id: "permissions",
		name: "权限控制",
		description: "控制工具调用、文件写入和需要人工确认的高风险操作。",
		category: "核心",
		required: true,
		files: ["permissions.js"],
		requires: ["session-runtime"],
		capabilities: ["权限模式", "工具调用策略", "交互审批"],
	},
	{
		id: "legacy-tools",
		name: "工具兼容层",
		description: "把现有 Python、Shell、文件和安全工具接入 Pi Agent。",
		category: "工具",
		required: true,
		files: ["legacy-host.js", "legacy/secheur_pi_bridge.py"],
		requires: ["session-runtime", "permissions"],
		capabilities: ["Python 工具宿主", "Shell 与文件工具", "旧工具兼容"],
	},
	{
		id: "tool-router",
		name: "工具路由与发现",
		description: "按需发现和装载工具，避免把全部工具定义一次性塞入模型上下文。",
		category: "工具",
		required: true,
		files: ["router.js"],
		requires: ["session-runtime"],
		capabilities: ["tool_search", "延迟工具发现", "上下文节流"],
	},
	{
		id: "pi-plugin-host",
		name: "外置插件宿主",
		description: "发现、安装、更新和装载用户级或项目级 Pi 插件。",
		category: "核心",
		required: true,
		files: ["pi-plugins.js"],
		requires: ["session-runtime"],
		capabilities: ["外置插件发现", "安装与更新", "Desktop UI 资源"],
	},
	{
		id: "mcp",
		name: "MCP 运行时",
		description: "连接 MCP 服务，动态暴露工具并提供刷新与诊断能力。",
		category: "工具",
		files: ["mcp.js"],
		requires: ["session-runtime", "permissions"],
		capabilities: ["MCP 连接", "动态工具", "刷新与诊断"],
	},
	{
		id: "subagents",
		name: "子 Agent",
		description: "创建隔离的临时子会话执行可委派任务，并把结果返回主会话。",
		category: "Agent",
		files: ["subagent.js", "agent-definitions.js"],
		requires: ["session-runtime", "permissions"],
		capabilities: ["子会话", "Agent 发现", "任务委派"],
	},
	{
		id: "progress-judge",
		name: "进度判断",
		description: "周期性判断任务是否推进、阻塞或完成，并向主 Agent 注入提醒。",
		category: "计划",
		files: ["progress-judge.js"],
		requires: ["session-runtime"],
		configKey: "judge",
		capabilities: ["进度评估", "停滞检测", "完成判断"],
	},
	{
		id: "progressive-planning",
		name: "顺序计划",
		description: "由 Controller 接管题目入口，按依赖渐进规划、租约执行并持久化证据。",
		category: "计划",
		files: [
			"planning/store.js",
			"planning/compiler.js",
			"planning/scheduler.js",
			"planning/harness.js",
			"planning/pi-adapters.js",
			"planning/controller.js",
			"planning/session-controller.js",
		],
		requires: ["session-runtime", "subagents"],
		configKey: "planning",
		capabilities: ["渐进式规划", "任务租约", "证据提交", "崩溃恢复"],
	},
	{
		id: "hypothesis-planning",
		name: "假设 DAG 计划",
		description: "基于证据看板与假设依赖规划，复用 Pi 执行与任务租约。",
		category: "计划",
		files: ["planning/hypothesis-adapters.js", "planning/hypothesis-graph.js"],
		requires: ["session-runtime", "subagents"],
		configKey: "planning",
		capabilities: ["假设 DAG", "证据看板", "依赖编排"],
	},
	{
		id: "artex-planning",
		name: "Artex 探索图计划",
		description: "事件驱动的探索图、意图队列与证据回写，复用 Pi 会话和原生校验。",
		category: "计划",
		files: ["planning/artex-adapters.js", "planning/artex-graph.js"],
		requires: ["session-runtime", "subagents"],
		configKey: "planning",
		capabilities: ["探索图", "资产锚点", "事件调度", "冷图摘要"],
	},
	{
		id: "cairn-planning",
		name: "Cairn Graph 计划",
		description: "独立 Graph Reasoner 与 Intent 调度，共用 Pi 执行底座。",
		category: "计划",
		files: ["planning/cairn/engine.js", "planning/cairn/solver.js"],
		requires: ["session-runtime", "subagents"],
		configKey: "planning",
		capabilities: ["Graph 规划", "动态并发", "Solver 会话复用", "成果回写"],
	},
	{
		id: "legacy-tree-planning",
		name: "旧树形计划",
		description: "旧版 plan_expand/plan_revise/plan_status 工具链；仅用于兼容，主动顺序计划接管时应关闭。",
		category: "计划",
		files: ["legacy-host.js"],
		requires: ["legacy-tools"],
		configKey: "legacyPlanning",
		capabilities: ["树形展开", "计划修订", "计划状态"],
	},
	{
		id: "sequential-worklist",
		name: "竞赛任务编排（Worklist）",
		description: "维护外层持久化题目清单，按依赖和状态调度、重试、停止与人工指导任务。",
		category: "编排",
		files: ["worklist.js", "worklist-store.js", "scheduler.js"],
		requires: ["session-runtime", "subagents"],
		capabilities: ["题目清单", "依赖调度", "重试与人工指导"],
	},
	{
		id: "competition-orchestrator",
		name: "竞赛编排",
		description: "协调题目、求解器、证据、进度事件与结果提交。",
		category: "编排",
		files: ["competition-runtime.js", "competition-broker.js", "competition-solver.js"],
		requires: ["session-runtime", "subagents"],
		capabilities: ["任务协调", "证据事件", "求解器生命周期"],
	},
	{
		id: "flag-oracle",
		name: "Flag 验证",
		description: "收集候选 Flag、验证提交结果并记录尝试反馈。",
		category: "安全",
		files: ["flag-oracle.js", "legacy/flag_oracle.py"],
		requires: ["legacy-tools"],
		capabilities: ["候选验证", "提交反馈", "尝试审计"],
	},
	{
		id: "local-memory",
		name: "本地记忆",
		description: "检索历史操作记忆和攻击知识，为当前任务补充相关上下文。",
		category: "记忆",
		files: ["legacy/memory", "legacy/secheur_pi_bridge.py"],
		requires: ["legacy-tools"],
		configKey: "memory",
		capabilities: ["操作记忆", "攻击记忆", "上下文引用"],
	},
	{
		id: "knowledge-prefetch",
		name: "知识预取",
		description: "在任务开始前主动查询本地记忆，把相关知识注入系统提示。",
		category: "记忆",
		files: ["extension.js"],
		requires: ["local-memory"],
		capabilities: ["任务前检索", "相关性筛选", "提示注入"],
	},
	{
		id: "response-guard",
		name: "完成质量守卫",
		description: "在 Agent 宣布完成时检查证据、验证状态和空行动，降低误完成率。",
		category: "安全",
		files: ["extension.js", "prompt-payload.js"],
		requires: ["session-runtime"],
		capabilities: ["完成检查", "验证门禁", "响应约束"],
	},
	{
		id: "ultracode",
		name: "Ultracode",
		description: "提供隔离工作树、验证器和长任务代码执行能力。",
		category: "工程",
		files: ["ultracode.js", "ultracode-worktree.js", "ultracode-verifier.js"],
		requires: ["permissions"],
		capabilities: ["隔离工作树", "代码验证", "长任务执行"],
	},
	{
		id: "repoaudit",
		name: "RepoAudit",
		description: "对代码仓库执行静态分析和安全审计；适配器随 Agent 包一起分发。",
		category: "工程",
		files: ["../node_modules/@repoaudit/typescript-adapter/package.json"],
		requires: ["permissions"],
		capabilities: ["仓库审计", "静态分析", "问题定位"],
	},
	{
		id: "git-checkpoint",
		name: "Git 检查点",
		description: "在长任务中记录可恢复的 Git 状态，支持失败后的继续执行。",
		category: "工程",
		files: ["git-checkpoint.js"],
		requires: ["session-runtime"],
		capabilities: ["检查点", "恢复状态", "变更追踪"],
	},
	{
		id: "python-runtime",
		name: "Python 运行时",
		description: "解析并管理 Agent 内置 Python 工具所需的解释器和运行环境。",
		category: "工具",
		files: ["python-runtime.js"],
		requires: ["legacy-tools"],
		capabilities: ["解释器发现", "运行环境", "工具依赖"],
	},
];

function runtimePath(relativePath: string): string {
	const compiled = join(moduleDirectory, relativePath);
	if (existsSync(compiled)) return compiled;
	return relativePath.endsWith(".js") ? join(moduleDirectory, relativePath.slice(0, -3) + ".ts") : compiled;
}

function readJson(path: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function legacyPlanningEnabled(config: SecHeurConfig): boolean {
	if (config.executionMode.legacyPlanningMode === "active") return false;
	return ["plan_expand", "plan_revise", "plan_status"].some((name) => config.registry.tools[name] !== false);
}

function configuredEnabled(
	config: SecHeurConfig,
	descriptor: BuiltinDescriptor,
	desktopConfig: Record<string, unknown>,
): boolean {
	if (descriptor.required) return true;
	if (descriptor.id === "hypothesis-planning")
		return config.executionMode.planningEnabled && config.planning.engine === "hypothesis";
	if (descriptor.id === "artex-planning")
		return config.executionMode.planningEnabled && config.planning.engine === "artex";
	if (descriptor.id === "cairn-planning")
		return config.executionMode.planningEnabled && config.planning.engine === "cairn";
	if (descriptor.id === "progressive-planning")
		return config.executionMode.planningEnabled && (config.planning.engine ?? "progressive") === "progressive";
	if (descriptor.configKey === "judge") return config.judge.enabled !== false;
	if (descriptor.configKey === "memory") return desktopConfig.memoryReferenceEnabled !== false;
	if (descriptor.configKey === "planning") return config.executionMode.planningEnabled;
	if (descriptor.configKey === "legacyPlanning") return legacyPlanningEnabled(config);
	return true;
}

function builtinCatalog(config: SecHeurConfig): UnifiedPluginCatalogItem[] {
	const desktopConfig = readJson(join(config.stateDir, "desktop-config.json"));
	return BUILTIN_COMPONENTS.map((descriptor) => {
		const missing = descriptor.files.filter((relativePath) => !existsSync(runtimePath(relativePath)));
		const available = missing.length === 0;
		const enabled = configuredEnabled(config, descriptor, desktopConfig);
		const planningMode = descriptor.configKey === "planning" ? config.planning.mode : undefined;
		const mutable = descriptor.configKey === "planning";
		return {
			key: `builtin:${descriptor.id}`,
			id: descriptor.id,
			kind: "builtin",
			name: descriptor.name,
			description: descriptor.description,
			category: descriptor.category,
			configuredEnabled: enabled,
			effectiveEnabled: enabled && available,
			available,
			required: descriptor.required === true,
			mutable,
			requires: descriptor.requires ?? [],
			blockedBy: missing,
			reason: !available
				? "missing-runtime-files"
				: descriptor.required
					? "system-required"
					: planningMode
						? `${planningMode}-mode`
						: enabled
							? "runtime-managed"
							: "disabled-by-config",
			capabilities: descriptor.capabilities,
			actions: { toggle: mutable, update: false, remove: false, open: false },
			...(planningMode ? { planningMode } : {}),
		};
	});
}

function externalPlugin(item: PiPluginInfo): UnifiedPluginCatalogItem {
	const capabilities: string[] = [];
	for (const [key, label] of Object.entries({
		extensions: "扩展",
		skills: "技能",
		prompts: "Prompt",
		themes: "主题",
	})) {
		const count = Number(item.resources[key as keyof PiPluginInfo["resources"]] ?? 0);
		if (count > 0) capabilities.push(`${label} ${count}`);
	}
	const desktopResources = item.desktopUi.styles + item.desktopUi.scripts;
	if (desktopResources > 0) capabilities.push(`会话 UI ${desktopResources}`);
	return {
		...item,
		key: `pi:${item.scope}:${item.source}`,
		id: item.source,
		kind: "pi",
		name: item.name || item.source,
		description: item.description || "外置 Pi 插件",
		category: "外置插件",
		configuredEnabled: item.enabled !== false,
		effectiveEnabled: item.enabled !== false && item.installed,
		available: item.installed,
		required: false,
		mutable: true,
		requires: [],
		blockedBy: item.installed ? [] : ["plugin-not-installed"],
		reason: !item.installed ? "plugin-not-installed" : item.enabled === false ? "disabled-by-config" : "enabled",
		capabilities,
		actions: {
			toggle: true,
			update: item.installed && item.sourceType !== "local",
			remove: true,
			open: Boolean(item.installedPath),
		},
	};
}

export async function listUnifiedPluginCatalog(config: SecHeurConfig): Promise<UnifiedPluginCatalog> {
	const piSnapshot = await listPiPlugins(config);
	const builtins = builtinCatalog(config);
	const external = piSnapshot.plugins.map(externalPlugin);
	const plugins = [...builtins, ...external];
	return {
		plugins,
		diagnostics: piSnapshot.diagnostics,
		counts: {
			total: plugins.length,
			builtin: builtins.length,
			external: external.length,
			enabled: plugins.filter((item) => item.effectiveEnabled).length,
		},
		settingsPaths: {
			internal: join(config.stateDir, "desktop-config.json"),
			user: piSnapshot.settingsPaths.user,
			project: piSnapshot.settingsPaths.project,
		},
	};
}

export function setBuiltinPlanningEnabled(
	config: SecHeurConfig,
	enabled: boolean,
	engine?: "progressive" | "cairn" | "hypothesis" | "artex",
): Record<string, unknown> {
	const path = join(config.stateDir, "desktop-config.json");
	const current = readJson(path);
	// Disabling an inactive plugin must not disable the other selected engine.
	if (!enabled && engine && engine !== (config.planning.engine ?? "progressive")) return current;
	const planning =
		current.planning && typeof current.planning === "object" && !Array.isArray(current.planning)
			? (current.planning as Record<string, unknown>)
			: {};
	// Persist a complete, self-consistent execution contract.  In particular,
	// turning Planning off must not leave a previously selected PLAN_MULTI
	// capacity behind, because DIRECT only accepts capacity=1.
	const nextExecutionMode = enabled
		? config.executionMode.mode === "plan_multi"
			? resolveExecutionMode({ mode: "plan_multi", capacity: config.executionMode.capacity })
			: resolveExecutionMode({ mode: "plan_single" })
		: resolveExecutionMode({ mode: "direct" });
	const next = {
		...current,
		executionMode: nextExecutionMode.mode,
		executionCapacity: nextExecutionMode.capacity,
		planning: { ...planning, mode: nextExecutionMode.legacyPlanningMode, ...(enabled && engine ? { engine } : {}) },
	};
	mkdirSync(config.stateDir, { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
	if (enabled) {
		const settingsPath = join(config.stateDir, "settings.json");
		const settings = readJson(settingsPath);
		const tools =
			settings.tools && typeof settings.tools === "object" && !Array.isArray(settings.tools)
				? (settings.tools as Record<string, unknown>)
				: {};
		const nextSettings = {
			...settings,
			tools: { ...tools, plan_expand: false, plan_revise: false, plan_status: false },
		};
		const settingsTemporary = `${settingsPath}.${process.pid}.tmp`;
		writeFileSync(settingsTemporary, `${JSON.stringify(nextSettings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(settingsTemporary, settingsPath);
	}
	return next;
}
