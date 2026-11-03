import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { isRegistryResourceEnabled, type SecHeurConfig } from "./config.ts";

export type AgentSource = "builtin" | "user" | "project";

export interface AgentDefinition {
	name: string;
	description: string;
	whenToUse: string;
	allowedTools?: string[];
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

const BUILTIN_AGENTS: readonly AgentDefinition[] = [
	{
		name: "reviewer",
		description: "Code review specialist focused on bugs, regressions, risks, and missing tests.",
		whenToUse: "Use for independent review of code changes, diffs, or implementation plans.",
		allowedTools: ["file_read", "grep_search", "list_files"],
		systemPrompt:
			"Review $TASK. Prioritize concrete bugs, behavioral regressions, missing tests, and risky assumptions. " +
			"Return findings first, ordered by severity, with file and line evidence when available.",
		source: "builtin",
		filePath: "<builtin:reviewer>",
	},
	{
		name: "researcher",
		description: "Research specialist for focused codebase or documentation investigation.",
		whenToUse: "Use when a task needs independent discovery, comparison, or evidence gathering.",
		allowedTools: ["file_read", "grep_search", "list_files", "web_fetch"],
		systemPrompt:
			"Research $TASK. Gather focused evidence, cite the files, commands, or sources inspected, and separate " +
			"facts from inferences. Return findings, uncertainty, and recommended next steps.",
		source: "builtin",
		filePath: "<builtin:researcher>",
	},
	{
		name: "planner",
		description: "Planning specialist for decomposing implementation work into verifiable steps.",
		whenToUse: "Use before complex implementation or when sequencing and risk control matter.",
		allowedTools: ["file_read", "grep_search", "list_files"],
		systemPrompt:
			"Plan $TASK. Decompose the work into small ordered steps with verification after each meaningful change. " +
			"Call out dependencies, risky files, and tests that should prove the result.",
		source: "builtin",
		filePath: "<builtin:planner>",
	},
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function toolNames(value: unknown): string[] | undefined {
	const values = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.replace(/^\[|\]$/gu, "").split(",")
			: [];
	const tools = values
		.flatMap((item) => (typeof item === "string" ? [item.trim().replace(/^['"]|['"]$/gu, "")] : []))
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function parseAgentFile(filePath: string, source: Exclude<AgentSource, "builtin">): AgentDefinition | undefined {
	const raw = readFileSync(filePath, "utf8");
	let metadata: Record<string, unknown> = {};
	let body = raw.trim();
	if (raw.startsWith("---")) {
		const end = raw.indexOf("\n---", 3);
		if (end >= 0) {
			const parsed: unknown = parse(raw.slice(3, end));
			if (isRecord(parsed)) metadata = parsed;
			body = raw.slice(end + 4).trim();
		}
	}
	const name = text(metadata.name) || filePath.split(/[\\/]/u).at(-1)?.replace(/\.md$/u, "") || "";
	if (!name || !body) return undefined;
	return {
		name,
		description: text(metadata.description),
		whenToUse: text(metadata.when_to_use ?? metadata["when-to-use"]),
		allowedTools: toolNames(metadata["allowed-tools"] ?? metadata.allowed_tools ?? metadata.tools),
		systemPrompt: body,
		source,
		filePath,
	};
}

function loadAgentDirectory(directory: string, source: Exclude<AgentSource, "builtin">): AgentDefinition[] {
	if (!existsSync(directory)) return [];
	try {
		return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			if (!entry.isFile() || !entry.name.endsWith(".md")) return [];
			try {
				const agent = parseAgentFile(join(directory, entry.name), source);
				return agent ? [agent] : [];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}

export function discoverAgentDefinitions(config: SecHeurConfig, includeDisabled = false): AgentDefinition[] {
	const agents = new Map(BUILTIN_AGENTS.map((agent) => [agent.name, { ...agent }]));
	for (const agent of loadAgentDirectory(join(config.agentDir, "agents"), "user")) agents.set(agent.name, agent);
	for (const agent of loadAgentDirectory(join(config.stateDir, "agents"), "project")) agents.set(agent.name, agent);
	return [...agents.values()].filter(
		(agent) => includeDisabled || isRegistryResourceEnabled(config, "agents", agent.name),
	);
}
