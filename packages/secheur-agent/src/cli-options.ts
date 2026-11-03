import { disabledRegistryNames, isRegistryResourceEnabled, type SecHeurConfig } from "./config.ts";

export interface TakenOption {
	args: string[];
	value?: string;
	missingValue?: string;
}

export interface TakenBooleanFlag {
	args: string[];
	found: boolean;
}

export function takeBooleanFlag(args: string[], names: string[]): TakenBooleanFlag {
	const remaining: string[] = [];
	let found = false;
	for (const argument of args) {
		if (names.includes(argument)) found = true;
		else remaining.push(argument);
	}
	return { args: remaining, found };
}

export function takeOption(args: string[], names: string[]): TakenOption {
	const remaining: string[] = [];
	let value: string | undefined;
	let missingValue: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		const name = names.find((candidate) => argument === candidate || argument.startsWith(`${candidate}=`));
		if (!name) {
			remaining.push(argument);
			continue;
		}
		if (argument.startsWith(`${name}=`)) {
			const inlineValue = argument.slice(name.length + 1);
			if (inlineValue) value = inlineValue;
			else missingValue = name;
			continue;
		}
		const next = args[index + 1];
		if (next && !next.startsWith("-")) {
			value = next;
			index += 1;
		} else {
			missingValue = name;
		}
	}
	return { args: remaining, value, ...(missingValue ? { missingValue } : {}) };
}

function optionValues(args: string[], names: string[]): { args: string[]; values: string[] } {
	const remaining: string[] = [];
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		const name = names.find((candidate) => argument === candidate || argument.startsWith(`${candidate}=`));
		if (!name) {
			remaining.push(argument);
			continue;
		}
		const inlineValue = argument.startsWith(`${name}=`) ? argument.slice(name.length + 1) : undefined;
		const value = inlineValue ?? args[index + 1];
		if (!value || (inlineValue === undefined && value.startsWith("-"))) {
			throw new Error(`${name} requires a value`);
		}
		values.push(value);
		if (inlineValue === undefined) index += 1;
	}
	return { args: remaining, values };
}

export function mergeDisabledTools(args: string[], config: SecHeurConfig): string[] {
	const parsed = optionValues(args, ["--exclude-tools", "-xt"]);
	const disabled = new Set(
		disabledRegistryNames(config, "tools").filter(
			(name) => name !== "attack_memory_search" || config.registry.tools.attack_memory_search === false,
		),
	);
	for (const value of parsed.values) {
		for (const name of value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean)) {
			disabled.add(name);
		}
	}
	if (disabled.size === 0) return parsed.args;
	return [...parsed.args, "--exclude-tools", [...disabled].sort().join(",")];
}

export function piSessionArgs(args: string[], config: SecHeurConfig): string[] {
	const managementCommands = new Set(["auth", "config", "install", "list", "remove", "uninstall", "update"]);
	if (args[0] && managementCommands.has(args[0])) return args;

	const systemPrompt = optionValues(args, ["--system-prompt"]);
	let result = mergeDisabledTools(systemPrompt.args, config);
	if (systemPrompt.values.length > 0) {
		for (const value of systemPrompt.values) result.push("--system-prompt", value);
	} else {
		result = [...result, "--system-prompt", config.systemPromptPath];
	}
	const hasExplicitModel = result.some((argument) => argument === "--model" || argument.startsWith("--model="));
	const hasExplicitProvider = result.some(
		(argument) => argument === "--provider" || argument.startsWith("--provider="),
	);
	if (!hasExplicitModel && !hasExplicitProvider && process.env.SECHEUR_ROUTER_DEFAULT !== "0") {
		result.push("--model", "router/auto");
	}
	if (!result.some((argument) => argument === "--thinking" || argument.startsWith("--thinking="))) {
		result.push("--thinking", "max");
	}
	return result;
}

export function filterEnabledSkills<T extends { name: string }, D>(
	config: SecHeurConfig,
	base: { skills: T[]; diagnostics: D[] },
): { skills: T[]; diagnostics: D[] } {
	return {
		skills: base.skills.filter((skill) => isRegistryResourceEnabled(config, "skills", skill.name)),
		diagnostics: base.diagnostics,
	};
}
