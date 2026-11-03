import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { discoverAgentDefinitions } from "./agent-definitions.ts";
import { resolveSecHeurStateDir, type SecHeurConfig } from "./config.ts";
import { SECHEUR_VIRTUAL_TOOL_DEFINITIONS } from "./extension.ts";
import { loadLegacyToolSchemas } from "./legacy-host.ts";

export type DesktopJson = Record<string, unknown>;

const API_PROFILE_FIELDS = [
	"name",
	"type",
	"apikey",
	"apibase",
	"model",
	"api_mode",
	"relay_compat_system_prompt",
	"thinking_type",
	"thinking_budget_tokens",
	"reasoning_effort",
	"max_tokens",
	"max_retries",
	"connect_timeout",
	"read_timeout",
	"temperature",
	"context_win",
	"input_cost_per_1m",
	"output_cost_per_1m",
	"cache_read_cost_per_1m",
	"cache_creation_cost_per_1m",
	"proxy",
	"user_agent",
	"stream",
] as const;

const API_DEFAULTS: Record<string, DesktopJson> = {
	native_oai: {
		name: "gpt-native",
		apibase: "https://api.openai.com/v1",
		model: "gpt-5.4",
		api_mode: "chat_completions",
	},
	native_anthropic: {
		name: "anthropic-native",
		apibase: "https://api.anthropic.com",
		model: "anthropic-model",
		relay_compat_system_prompt: false,
		thinking_type: "adaptive",
	},
};

const RESOURCE_NAME = /^[A-Za-z0-9_.-]{1,80}$/u;

function isRecord(value: unknown): value is DesktopJson {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): DesktopJson {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(value) ? value : {};
	} catch {
		return {};
	}
}

function atomicWriteText(path: string, text: string, mode = 0o600): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporary, text, { encoding: "utf8", mode });
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			// Best-effort cleanup of a failed atomic write.
		}
		throw error;
	}
}

function atomicWriteJson(path: string, value: unknown): void {
	atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function stateDir(root: string): string {
	return resolveSecHeurStateDir(root);
}

function desktopConfigPath(root: string): string {
	return join(stateDir(root), "desktop-config.json");
}

function registryStatePath(root: string): string {
	return join(stateDir(root), "settings.json");
}

function apiProfilesPath(root: string): string {
	return join(stateDir(root), "api-profiles.json");
}

function bridgeStatePath(root: string): string {
	return join(stateDir(root), "bridge-state.json");
}

function mykeyPath(root: string): string {
	return join(root, "mykey.py");
}

function maskSecret(value: string): string {
	if (!value) return "";
	if (value.length <= 8) return "****";
	return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function textValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim();
}

function safeName(value: unknown, kind: string): string {
	const name = textValue(value);
	if (!RESOURCE_NAME.test(name))
		throw new Error(`${kind} name must use letters, numbers, dots, underscores or hyphens`);
	return name;
}

function stripSecret(config: DesktopJson): DesktopJson {
	const safe = { ...config };
	delete safe.apiKey;
	delete safe.api_key;
	safe.apikey = "";
	return safe;
}

interface StoredApiBundle {
	configs: DesktopJson[];
	activeNames: string[];
	piProviderIds: Record<string, string>;
}

interface ApiProfileRequirements {
	requireName?: boolean;
	requireModel?: boolean;
}

const PI_PROVIDER_PREFIX = "secheur-";

function splitTopLevel(value: string, separator = ","): string[] {
	const parts: string[] = [];
	let start = 0;
	let depth = 0;
	let quote = "";
	let escaped = false;
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = "";
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "{" || char === "[" || char === "(") depth += 1;
		else if (char === "}" || char === "]" || char === ")") depth = Math.max(0, depth - 1);
		else if (char === separator && depth === 0) {
			parts.push(value.slice(start, index).trim());
			start = index + 1;
		}
	}
	const tail = value.slice(start).trim();
	if (tail) parts.push(tail);
	return parts;
}

function topLevelColon(value: string): number {
	let depth = 0;
	let quote = "";
	let escaped = false;
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = "";
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "{" || char === "[" || char === "(") depth += 1;
		else if (char === "}" || char === "]" || char === ")") depth = Math.max(0, depth - 1);
		else if (char === ":" && depth === 0) return index;
	}
	return -1;
}

function parsePythonString(raw: string): string {
	const quote = raw[0];
	const body = raw.slice(1, raw.endsWith(quote) ? -1 : undefined);
	let output = "";
	for (let index = 0; index < body.length; index += 1) {
		const char = body[index];
		if (char !== "\\" || index === body.length - 1) {
			output += char;
			continue;
		}
		const next = body[++index];
		const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", a: "a" };
		if (escapes[next] !== undefined) output += escapes[next];
		else if (next === "x" && /^[0-9a-f]{2}$/iu.test(body.slice(index + 1, index + 3))) {
			output += String.fromCharCode(Number.parseInt(body.slice(index + 1, index + 3), 16));
			index += 2;
		} else if (next === "u" && /^[0-9a-f]{4}$/iu.test(body.slice(index + 1, index + 5))) {
			output += String.fromCharCode(Number.parseInt(body.slice(index + 1, index + 5), 16));
			index += 4;
		} else output += next;
	}
	return output;
}

function parsePythonValue(raw: string): unknown {
	const value = raw.trim().replace(/,\s*$/u, "");
	if (!value) return "";
	if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
		return parsePythonString(value);
	}
	if (value === "True") return true;
	if (value === "False") return false;
	if (value === "None") return null;
	if (value.startsWith("[") && value.endsWith("]")) return splitTopLevel(value.slice(1, -1)).map(parsePythonValue);
	if (value.startsWith("{") && value.endsWith("}")) {
		const object: DesktopJson = {};
		for (const item of splitTopLevel(value.slice(1, -1))) {
			const colon = topLevelColon(item);
			if (colon < 0) continue;
			const key = textValue(parsePythonValue(item.slice(0, colon)));
			if (key) object[key] = parsePythonValue(item.slice(colon + 1));
		}
		return object;
	}
	if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(value)) return Number(value);
	return value;
}

function assignmentBodies(source: string): Array<{ name: string; body: string }> {
	const result: Array<{ name: string; body: string }> = [];
	const pattern = /^([A-Za-z_]\w*)\s*=\s*\{/gmu;
	for (const match of source.matchAll(pattern)) {
		const name = match[1];
		const open = (match.index ?? 0) + match[0].lastIndexOf("{");
		let depth = 0;
		let quote = "";
		let escaped = false;
		let close = -1;
		for (let index = open; index < source.length; index += 1) {
			const char = source[index];
			if (quote) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === quote) quote = "";
				continue;
			}
			if (char === "'" || char === '"') {
				quote = char;
				continue;
			}
			if (char === "{") depth += 1;
			else if (char === "}" && --depth === 0) {
				close = index;
				break;
			}
		}
		if (close >= 0) result.push({ name, body: source.slice(open + 1, close) });
	}
	return result;
}

function parsePythonObject(body: string): DesktopJson {
	const object: DesktopJson = {};
	for (const item of splitTopLevel(body)) {
		const colon = topLevelColon(item);
		if (colon < 0) continue;
		const key = textValue(parsePythonValue(item.slice(0, colon)));
		if (key) object[key] = parsePythonValue(item.slice(colon + 1));
	}
	return object;
}

function parseMykey(path: string): StoredApiBundle {
	if (!existsSync(path)) return { configs: [], activeNames: [], piProviderIds: {} };
	let source = "";
	try {
		source = readFileSync(path, "utf8");
	} catch {
		return { configs: [], activeNames: [], piProviderIds: {} };
	}
	let activeNames: string[] = [];
	const configs: DesktopJson[] = [];
	for (const assignment of assignmentBodies(source)) {
		if (assignment.name === "mixin_config") {
			const value = parsePythonObject(assignment.body).llm_nos;
			if (Array.isArray(value)) activeNames = value.filter((item): item is string => typeof item === "string");
			continue;
		}
		if (!/(config|api|cookie)/iu.test(assignment.name)) continue;
		const config = parsePythonObject(assignment.body);
		if (!config.apikey && !config.apibase && !config.model) continue;
		config.type = textValue(config.type) || (/anthropic/iu.test(assignment.name) ? "native_anthropic" : "native_oai");
		config.name = textValue(config.name) || textValue(config.model) || assignment.name;
		config.varName = assignment.name;
		configs.push(config);
	}
	if (activeNames.length === 0 && configs[0]) activeNames = [textValue(configs[0].name)];
	return { configs, activeNames, piProviderIds: {} };
}

function normalizeStoredBundle(root: string): StoredApiBundle {
	const sidecar = readJson(apiProfilesPath(root));
	const storedProfiles = Array.isArray(sidecar.profiles)
		? sidecar.profiles
		: Array.isArray(sidecar.configs)
			? sidecar.configs
			: undefined;
	if (storedProfiles) {
		const configs = storedProfiles.filter(isRecord).map((profile) => ({ ...profile }));
		const activeNames = Array.isArray(sidecar.activeNames)
			? sidecar.activeNames.filter((item): item is string => typeof item === "string")
			: [];
		const piProviderIds = isRecord(sidecar.piProviderIds)
			? Object.fromEntries(
					Object.entries(sidecar.piProviderIds).flatMap(([name, value]) =>
						typeof value === "string" && value.startsWith(PI_PROVIDER_PREFIX) ? [[name, value]] : [],
					),
				)
			: {};
		if (configs.length > 0)
			return {
				configs,
				activeNames: activeNames.length > 0 ? activeNames : [textValue(configs[0].name)],
				piProviderIds,
			};
	}
	return parseMykey(mykeyPath(root));
}

function profileView(
	config: DesktopJson,
	index: number,
	activeNames: string[],
	piProviderId: string | undefined,
): DesktopJson {
	const name = textValue(config.name) || textValue(config.model) || `profile-${index + 1}`;
	const varName =
		textValue(config.varName) ||
		`${textValue(config.type) === "native_anthropic" ? "native_anthropic" : "native_oai"}_config`;
	const apikey = textValue(config.apikey ?? config.apiKey ?? config.api_key);
	const safe = stripSecret(config);
	delete safe.varName;
	return {
		id: name,
		name,
		varName,
		type: textValue(config.type) || "native_oai",
		model: textValue(config.model),
		apibase: textValue(config.apibase ?? config.base_url ?? config.baseUrl),
		hasApiKey: Boolean(apikey),
		maskedApiKey: maskSecret(apikey),
		active: activeNames.includes(name) || (activeNames.length === 0 && index === 0),
		piProviderId: piProviderId ?? "",
		config: safe,
	};
}

export function readApiConfig(root: string): Record<string, unknown> {
	const bundle = normalizeStoredBundle(root);
	const profiles = bundle.configs.map((config, index) => {
		const name = textValue(config.name) || textValue(config.model) || `profile-${index + 1}`;
		return profileView(config, index, bundle.activeNames, bundle.piProviderIds[name]);
	});
	const activeNames =
		bundle.activeNames.length > 0 ? bundle.activeNames : profiles.slice(0, 1).map((item) => textValue(item.name));
	const current =
		bundle.configs.find((config) => activeNames.includes(textValue(config.name))) ?? bundle.configs[0] ?? {};
	const apiKey = textValue(current.apikey ?? current.apiKey ?? current.api_key);
	return {
		mykeyPath: mykeyPath(root),
		hasApiKey: Boolean(apiKey),
		maskedApiKey: maskSecret(apiKey),
		config: stripSecret(current),
		profiles,
		activeNames,
	};
}

function normalizeApiProfile(
	input: DesktopJson,
	existing: DesktopJson | undefined,
	requirements: ApiProfileRequirements = {},
): DesktopJson {
	const requestedType = textValue(input.type ?? existing?.type) || "native_oai";
	const type = requestedType === "native_anthropic" ? requestedType : "native_oai";
	const base = { ...(API_DEFAULTS[type] ?? API_DEFAULTS.native_oai), ...(existing ?? {}) };
	for (const field of API_PROFILE_FIELDS) {
		if (field in input && field !== "apikey") base[field] = input[field];
	}
	for (const [source, target] of [
		["apiKey", "apikey"],
		["api_key", "apikey"],
		["base_url", "apibase"],
		["baseUrl", "apibase"],
	] as const) {
		if (source in input) base[target] = input[source];
	}
	const suppliedKey = textValue(input.apikey ?? input.apiKey ?? input.api_key);
	const existingKey = textValue(existing?.apikey ?? existing?.apiKey ?? existing?.api_key);
	if (suppliedKey && suppliedKey !== maskSecret(existingKey)) base.apikey = suppliedKey;
	else if (existingKey) base.apikey = existingKey;
	else base.apikey = "";
	base.type = type;
	base.name = textValue(input.name ?? existing?.name ?? base.name);
	base.apibase = textValue(base.apibase);
	base.model = textValue(base.model);
	const requireName = requirements.requireName !== false;
	const requireModel = requirements.requireModel !== false;
	if ((requireName && !base.name) || !base.apibase || (requireModel && !base.model)) {
		throw new Error("API profile requires name, apibase, and model");
	}
	delete base.apiKey;
	delete base.api_key;
	delete base.base_url;
	delete base.baseUrl;
	delete base.varName;
	return base;
}

export function resolveApiProfile(
	root: string,
	input: DesktopJson,
	requirements: ApiProfileRequirements = {},
): DesktopJson {
	const bundle = normalizeStoredBundle(root);
	const form = isRecord(input.config) ? input.config : input;
	const name = textValue(form.name);
	const existing = bundle.configs.find((config) => textValue(config.name) === name);
	return normalizeApiProfile(form, existing, requirements);
}

function pythonLiteral(value: unknown): string {
	if (value === null) return "None";
	if (value === true) return "True";
	if (value === false) return "False";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(", ")}]`;
	if (isRecord(value))
		return `{${Object.entries(value)
			.map(([key, item]) => `${pythonLiteral(key)}: ${pythonLiteral(item)}`)
			.join(", ")}}`;
	return "None";
}

function buildMykey(configs: DesktopJson[], activeNames: string[]): string {
	const lines = [
		"# SecHeur Agent model profiles generated by the desktop bridge.",
		"_SETUP_DONE = 'desktop-config'",
		"",
		"mixin_config = {",
		`    'llm_nos': ${pythonLiteral(activeNames)},`,
		"    'max_retries': 10,",
		"    'base_delay': 0.5,",
		"}",
	];
	const counters = new Map<string, number>();
	for (const config of configs) {
		const type = textValue(config.type) === "native_anthropic" ? "native_anthropic" : "native_oai";
		const count = counters.get(type) ?? 0;
		counters.set(type, count + 1);
		const variable = `${type}_config${count === 0 ? "" : `_${count}`}`;
		lines.push("", `${variable} = {`);
		for (const field of API_PROFILE_FIELDS) {
			if (field === "apikey" && config.apikey === undefined) continue;
			if (!(field in config) || config[field] === "" || config[field] === undefined || config[field] === null)
				continue;
			lines.push(`    ${pythonLiteral(field)}: ${pythonLiteral(config[field])},`);
		}
		lines.push("}");
	}
	lines.push("", "# Configure credentials through the desktop settings UI.", "");
	return lines.join("\n");
}

function readPiJsonForUpdate(path: string): DesktopJson {
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Cannot update ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) throw new Error(`Cannot update ${path}: expected a JSON object`);
	return parsed;
}

function piAgentDir(root: string): string {
	return join(stateDir(root), "pi");
}

function piProviderBase(name: string): string {
	const slug = name
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 48);
	return `${PI_PROVIDER_PREFIX}${slug || "profile"}`;
}

function allocatePiProviderIds(root: string, bundle: StoredApiBundle): void {
	const modelsDocument = readPiJsonForUpdate(join(piAgentDir(root), "models.json"));
	if (modelsDocument.providers !== undefined && !isRecord(modelsDocument.providers)) {
		throw new Error(`Cannot update ${join(piAgentDir(root), "models.json")}: providers must be a JSON object`);
	}
	const existingIds = new Set(Object.keys(isRecord(modelsDocument.providers) ? modelsDocument.providers : {}));
	const profileNames = new Set(bundle.configs.map((config) => textValue(config.name)).filter(Boolean));
	for (const name of Object.keys(bundle.piProviderIds)) {
		if (!profileNames.has(name)) delete bundle.piProviderIds[name];
	}
	const claimed = new Set<string>();
	for (const config of bundle.configs) {
		const name = textValue(config.name);
		const stored = bundle.piProviderIds[name];
		if (stored?.startsWith(PI_PROVIDER_PREFIX) && !claimed.has(stored)) {
			claimed.add(stored);
			continue;
		}
		const base = piProviderBase(name);
		let candidate = base;
		if (existingIds.has(candidate) || claimed.has(candidate)) {
			const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
			candidate = `${base.slice(0, 55)}-${hash}`;
			let suffix = 2;
			while (existingIds.has(candidate) || claimed.has(candidate)) {
				candidate = `${base.slice(0, 50)}-${hash}-${suffix}`;
				suffix += 1;
			}
		}
		bundle.piProviderIds[name] = candidate;
		claimed.add(candidate);
	}
}

function finiteNumber(value: unknown): number | undefined {
	if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return undefined;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveNumber(value: unknown): number | undefined {
	const parsed = finiteNumber(value);
	return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function piApi(config: DesktopJson): "anthropic-messages" | "openai-completions" | "openai-responses" {
	if (textValue(config.type) === "native_anthropic") return "anthropic-messages";
	const mode = textValue(config.api_mode).toLowerCase().replaceAll("-", "_");
	return mode === "response" || mode === "responses" ? "openai-responses" : "openai-completions";
}

function piProvider(config: DesktopJson): DesktopJson {
	const model: DesktopJson = {
		id: textValue(config.model),
		name: textValue(config.model),
		input: ["text", "image"],
	};
	const thinkingType = textValue(config.thinking_type).toLowerCase();
	const reasoningEffort = textValue(config.reasoning_effort).toLowerCase();
	model.reasoning =
		(thinkingType !== "" && thinkingType !== "disabled") || (reasoningEffort !== "" && reasoningEffort !== "none");
	const contextWindow = positiveNumber(config.context_win);
	if (contextWindow !== undefined) model.contextWindow = contextWindow;
	const maxTokens = positiveNumber(config.max_tokens);
	if (maxTokens !== undefined) model.maxTokens = maxTokens;
	const temperature = finiteNumber(config.temperature);
	if (temperature !== undefined) model.samplingParams = { temperature };
	const costs = [
		finiteNumber(config.input_cost_per_1m),
		finiteNumber(config.output_cost_per_1m),
		finiteNumber(config.cache_read_cost_per_1m),
		finiteNumber(config.cache_creation_cost_per_1m),
	];
	if (costs.some((cost) => cost !== undefined)) {
		model.cost = {
			input: costs[0] ?? 0,
			output: costs[1] ?? 0,
			cacheRead: costs[2] ?? 0,
			cacheWrite: costs[3] ?? 0,
		};
	}
	return {
		name: textValue(config.name),
		baseUrl: textValue(config.apibase),
		api: piApi(config),
		models: [model],
	};
}

function syncPiApiBundle(root: string, bundle: StoredApiBundle, removedProviderIds: string[] = []): void {
	const agentDir = piAgentDir(root);
	const modelsPath = join(agentDir, "models.json");
	const authPath = join(agentDir, "auth.json");
	const settingsPath = join(agentDir, "settings.json");
	const modelsDocument = readPiJsonForUpdate(modelsPath);
	const authDocument = readPiJsonForUpdate(authPath);
	const settingsDocument = readPiJsonForUpdate(settingsPath);
	if (modelsDocument.providers !== undefined && !isRecord(modelsDocument.providers)) {
		throw new Error(`Cannot update ${modelsPath}: providers must be a JSON object`);
	}
	const providers: DesktopJson = { ...(isRecord(modelsDocument.providers) ? modelsDocument.providers : {}) };
	for (const providerId of removedProviderIds) {
		if (!providerId.startsWith(PI_PROVIDER_PREFIX)) continue;
		delete providers[providerId];
		delete authDocument[providerId];
	}
	for (const config of bundle.configs) {
		const name = textValue(config.name);
		const providerId = bundle.piProviderIds[name];
		if (!providerId) continue;
		providers[providerId] = piProvider(config);
		const apiKey = textValue(config.apikey ?? config.apiKey ?? config.api_key);
		if (apiKey) authDocument[providerId] = { type: "api_key", key: apiKey };
		else delete authDocument[providerId];
	}
	modelsDocument.providers = providers;
	const activeConfig = bundle.configs.find((config) => bundle.activeNames.includes(textValue(config.name)));
	if (activeConfig) {
		const providerId = bundle.piProviderIds[textValue(activeConfig.name)];
		if (providerId) {
			settingsDocument.defaultProvider = providerId;
			settingsDocument.defaultModel = textValue(activeConfig.model);
		}
	} else if (removedProviderIds.includes(textValue(settingsDocument.defaultProvider))) {
		delete settingsDocument.defaultProvider;
		delete settingsDocument.defaultModel;
	}
	atomicWriteJson(modelsPath, modelsDocument);
	atomicWriteJson(authPath, authDocument);
	atomicWriteJson(settingsPath, settingsDocument);
}

function persistApiBundle(root: string, bundle: StoredApiBundle, removedProviderIds: string[] = []): void {
	allocatePiProviderIds(root, bundle);
	syncPiApiBundle(root, bundle, removedProviderIds);
	const path = mykeyPath(root);
	if (existsSync(path)) copyFileSync(path, `${path}.bak`);
	atomicWriteJson(apiProfilesPath(root), {
		profiles: bundle.configs,
		activeNames: bundle.activeNames,
		piProviderIds: bundle.piProviderIds,
	});
	atomicWriteText(path, buildMykey(bundle.configs, bundle.activeNames));
}

export function saveApiConfig(root: string, input: DesktopJson): Record<string, unknown> {
	const bundle = normalizeStoredBundle(root);
	const form = isRecord(input.config) ? input.config : input;
	const name = textValue(form.name);
	const index = bundle.configs.findIndex((config) => textValue(config.name) === name);
	const existing = index >= 0 ? bundle.configs[index] : undefined;
	const config = normalizeApiProfile(form, existing);
	if (index >= 0) bundle.configs[index] = config;
	else bundle.configs.push(config);
	bundle.activeNames = form.activate === false ? bundle.activeNames.filter(Boolean) : [textValue(config.name)];
	if (bundle.activeNames.length === 0) bundle.activeNames = [textValue(config.name)];
	persistApiBundle(root, bundle);
	return readApiConfig(root);
}

export function deleteApiConfig(root: string, name: string): Record<string, unknown> {
	const bundle = normalizeStoredBundle(root);
	const index = bundle.configs.findIndex((config) => textValue(config.name) === textValue(name));
	if (index < 0) throw new Error("API profile not found");
	const deletedName = textValue(bundle.configs[index].name);
	const removedProviderId = bundle.piProviderIds[deletedName];
	bundle.configs.splice(index, 1);
	bundle.activeNames = bundle.activeNames.filter((item) => item !== textValue(name));
	delete bundle.piProviderIds[deletedName];
	if (bundle.configs.length === 0) {
		syncPiApiBundle(root, bundle, removedProviderId ? [removedProviderId] : []);
		const path = mykeyPath(root);
		if (existsSync(path)) {
			copyFileSync(path, `${path}.bak`);
			unlinkSync(path);
		}
		if (existsSync(apiProfilesPath(root))) unlinkSync(apiProfilesPath(root));
	} else {
		if (bundle.activeNames.length === 0) bundle.activeNames = [textValue(bundle.configs[0].name)];
		persistApiBundle(root, bundle, removedProviderId ? [removedProviderId] : []);
	}
	return { ...readApiConfig(root), deletedName: textValue(name) };
}

function readMcpServers(root: string): DesktopJson {
	const raw = readJson(join(stateDir(root), "mcp.json"));
	return isRecord(raw.mcpServers) ? raw.mcpServers : raw;
}

function normalizeMap(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => [[key, textValue(item)]]));
}

export function saveMcpServer(root: string, input: DesktopJson): Record<string, unknown> {
	const form = isRecord(input.config) ? input.config : input;
	const name = textValue(form.name);
	if (!name || name.includes("/") || name.includes("\\")) throw new Error("MCP server name is required");
	const url = textValue(form.url);
	const command = textValue(form.command);
	if (!url && !command) throw new Error("MCP command or HTTP URL is required");
	const server: DesktopJson = url
		? { url, ...(isRecord(form.headers) ? { headers: normalizeMap(form.headers) } : {}) }
		: {
				command,
				args: Array.isArray(form.args)
					? form.args.map(textValue).filter(Boolean)
					: textValue(form.args).split(/\s+/u).filter(Boolean),
				...(isRecord(form.env) ? { env: normalizeMap(form.env) } : {}),
				...(textValue(form.cwd) ? { cwd: textValue(form.cwd) } : {}),
			};
	const timeout = Number(form.timeout);
	if (Number.isFinite(timeout) && timeout > 0) server.timeout = timeout;
	const servers = readMcpServers(root);
	servers[name] = server;
	atomicWriteJson(join(stateDir(root), "mcp.json"), { mcpServers: servers });
	return { name, config: server, path: join(stateDir(root), "mcp.json") };
}

export function deleteMcpServer(root: string, name: string): Record<string, unknown> {
	const servers = readMcpServers(root);
	const key = textValue(name);
	if (!key || !servers[key]) throw new Error("Project MCP server not found");
	const removed = servers[key];
	delete servers[key];
	atomicWriteJson(join(stateDir(root), "mcp.json"), { mcpServers: servers });
	return { name: key, config: removed, path: join(stateDir(root), "mcp.json") };
}

function frontmatter(value: unknown): string {
	return textValue(value).replace(/[\r\n]+/gu, " ");
}

function yamlScalar(value: string): string {
	return JSON.stringify(value);
}

export function saveProjectSkill(root: string, input: DesktopJson): Record<string, unknown> {
	const form = isRecord(input.config) ? input.config : input;
	const name = safeName(form.name, "Skill");
	const body = textValue(form.body ?? form.prompt);
	if (!body) throw new Error("Skill body is required");
	const directory = join(stateDir(root), "skills", name);
	const path = join(directory, "SKILL.md");
	const context = textValue(form.context) === "fork" ? "fork" : "inline";
	const lines = ["---", `name: ${name}`];
	const description = frontmatter(form.description);
	if (description) lines.push(`description: ${yamlScalar(description)}`);
	if (context === "fork") lines.push("context: fork");
	lines.push("---", "", body, "");
	atomicWriteText(path, lines.join("\n"), 0o644);
	return { name, path, skillDir: directory };
}

export function deleteProjectSkill(root: string, name: string): Record<string, unknown> {
	const safe = safeName(name, "Skill");
	const directory = join(stateDir(root), "skills", safe);
	const path = join(directory, "SKILL.md");
	if (!existsSync(path)) throw new Error("Project Skill not found");
	rmSync(directory, { recursive: true, force: false });
	return { name: safe, path, skillDir: directory };
}

export function saveProjectAgent(root: string, input: DesktopJson): Record<string, unknown> {
	const form = isRecord(input.config) ? input.config : input;
	const name = safeName(form.name, "Agent");
	const body = textValue(form.body ?? form.prompt);
	if (!body) throw new Error("Agent body is required");
	const directory = join(stateDir(root), "agents");
	const path = join(directory, `${name}.md`);
	const lines = ["---", `name: ${name}`];
	const description = frontmatter(form.description);
	if (description) lines.push(`description: ${yamlScalar(description)}`);
	const whenToUse = frontmatter(form.whenToUse ?? form.when_to_use);
	if (whenToUse) lines.push(`when_to_use: ${yamlScalar(whenToUse)}`);
	const allowedTools = Array.isArray(form.allowedTools ?? form.allowed_tools)
		? ((form.allowedTools ?? form.allowed_tools) as unknown[])
		: [];
	const toolNames = allowedTools.map(textValue).filter(Boolean);
	if (toolNames.length > 0) lines.push(`allowed-tools: ${JSON.stringify(toolNames)}`);
	lines.push("---", "", body, "");
	atomicWriteText(path, lines.join("\n"), 0o644);
	return { name, path, agentDir: directory };
}

export function deleteProjectAgent(root: string, name: string): Record<string, unknown> {
	const safe = safeName(name, "Agent");
	const directory = join(stateDir(root), "agents");
	const path = join(directory, `${safe}.md`);
	if (!existsSync(path)) throw new Error("Project Agent not found");
	unlinkSync(path);
	return { name: safe, path, agentDir: directory };
}

export function readDesktopConfig(root: string): DesktopJson {
	return readJson(desktopConfigPath(root));
}

export function writeDesktopConfig(root: string, config: DesktopJson): void {
	atomicWriteJson(desktopConfigPath(root), config);
}

/**
 * Apply a settings patch without dropping keys the caller never sends.
 *
 * desktop-config.json is shared: the deployment seeds execution mode, planning
 * engine and capacity there, while the settings UI submits only the keys its
 * own form owns. A whole-file write from the UI would therefore erase the
 * deployment's configuration, so keys absent from `updates` are preserved.
 * Keys that are present are overwritten, which keeps "clear this field" working.
 */
export function updateDesktopConfig(root: string, updates: DesktopJson): DesktopJson {
	const current = readDesktopConfig(root);
	const merged: DesktopJson = { ...current, ...updates };
	atomicWriteJson(desktopConfigPath(root), merged);
	return merged;
}

export function readBridgeState(root: string): DesktopJson {
	return readJson(bridgeStatePath(root));
}

export function writeBridgeState(root: string, state: DesktopJson): void {
	atomicWriteJson(bridgeStatePath(root), state);
}

export function readRegistryState(root: string): DesktopJson {
	return readJson(registryStatePath(root));
}

export function writeRegistryState(root: string, updates: DesktopJson): DesktopJson {
	const state = readRegistryState(root);
	for (const key of ["mcpServers", "skills", "tools", "agents"]) {
		if (!isRecord(updates[key])) continue;
		const current = isRecord(state[key]) ? state[key] : {};
		for (const [name, enabled] of Object.entries(updates[key])) {
			current[name] =
				typeof enabled === "string"
					? !["0", "false", "no", "off", "disabled"].includes(enabled.toLowerCase())
					: Boolean(enabled);
		}
		state[key] = current;
	}
	atomicWriteJson(registryStatePath(root), state);
	return state;
}

function enabled(state: DesktopJson, key: string, name: string): boolean {
	const map = isRecord(state[key]) ? state[key] : {};
	return map[name] !== false;
}

function readFrontmatter(path: string): { name: string; description: string; body: string } {
	try {
		const text = readFileSync(path, "utf8");
		if (!text.startsWith("---")) return { name: "", description: "", body: text.trim() };
		const end = text.indexOf("\n---", 3);
		if (end < 0) return { name: "", description: "", body: text.trim() };
		const parsed: unknown = parse(text.slice(3, end));
		const metadata: DesktopJson = isRecord(parsed) ? parsed : {};
		return {
			name: textValue(metadata.name),
			description: textValue(metadata.description),
			body: text.slice(end + 4).trim(),
		};
	} catch {
		return { name: "", description: "", body: "" };
	}
}

function listSkillEntries(root: string, config: SecHeurConfig, state: DesktopJson): DesktopJson[] {
	const bases = [
		join(root, "skill"),
		join(root, "skills"),
		join(root, ".agents", "skills"),
		join(stateDir(root), "skills"),
		...config.skillPaths,
	];
	const seen = new Set<string>();
	const result: DesktopJson[] = [];
	for (const base of bases) {
		try {
			for (const entry of readdirSync(base, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const path = join(base, entry.name, "SKILL.md");
				if (!existsSync(path) || seen.has(path)) continue;
				seen.add(path);
				const parsed = readFrontmatter(path);
				const name = parsed.name || entry.name;
				result.push({
					name,
					description: parsed.description,
					body: parsed.body,
					path,
					sourcePath: path,
					enabled: enabled(state, "skills", name),
				});
			}
		} catch {
			// Optional skill directories may not exist.
		}
	}
	return result.sort((a, b) => textValue(a.name).localeCompare(textValue(b.name)));
}

function listAgentEntries(config: SecHeurConfig, state: DesktopJson): DesktopJson[] {
	return discoverAgentDefinitions(config, true)
		.map((agent) => ({
			name: agent.name,
			description: agent.description,
			whenToUse: agent.whenToUse,
			body: agent.systemPrompt,
			path: agent.source === "builtin" ? "" : agent.filePath,
			sourcePath: agent.source === "builtin" ? "" : agent.filePath,
			openPath: agent.source === "builtin" ? "" : dirname(agent.filePath),
			source: agent.source,
			allowedTools: agent.allowedTools ?? [],
			enabled: enabled(state, "agents", agent.name),
		}))
		.sort((a, b) => textValue(a.name).localeCompare(textValue(b.name)));
}

function listToolEntries(config: SecHeurConfig, state: DesktopJson): DesktopJson[] {
	const nativeDefinitions = [
		{ name: "read", description: "Read files and images from the project." },
		{ name: "bash", description: "Execute a shell command in the project working directory." },
		{ name: "edit", description: "Apply targeted text replacements to an existing file." },
		{ name: "write", description: "Write complete file contents." },
		{ name: "grep", description: "Search file contents and return matching lines." },
		{ name: "find", description: "Find files using glob patterns." },
		{ name: "ls", description: "List directory contents." },
	];
	const tools = new Map<string, DesktopJson>();
	for (const tool of nativeDefinitions) {
		tools.set(tool.name, {
			name: tool.name,
			description: tool.description,
			source: "pi",
			sourcePath: `<builtin:${tool.name}>`,
			enabled: enabled(state, "tools", tool.name),
		});
	}
	const schemaPath = join(config.legacyRoot, "assets", "tools_schema.json");
	try {
		for (const tool of loadLegacyToolSchemas(schemaPath)) {
			tools.set(tool.name, {
				name: tool.name,
				description: tool.description,
				source: "legacy",
				sourcePath: schemaPath,
				enabled: enabled(state, "tools", tool.name),
			});
		}
	} catch {
		// A missing legacy bundle is reported through the empty legacy portion of the registry.
	}
	for (const tool of [
		...SECHEUR_VIRTUAL_TOOL_DEFINITIONS,
		{
			name: "mcp_refresh",
			description: "Reconnect configured MCP servers and refresh their exposed tools.",
		},
	]) {
		if (tools.has(tool.name)) continue;
		tools.set(tool.name, {
			name: tool.name,
			description: tool.description,
			source: "secheur",
			sourcePath: "virtual",
			enabled: enabled(state, "tools", tool.name),
		});
	}
	return [...tools.values()].sort((a, b) => textValue(a.name).localeCompare(textValue(b.name)));
}

export function buildDesktopRegistry(root: string, config: SecHeurConfig): DesktopJson {
	const state = readRegistryState(root);
	const mcpServers = Object.entries(config.mcpServers).map(([name, server]) => ({
		name,
		enabled: enabled(state, "mcpServers", name),
		transport: server.transport,
		...(server.transport === "http"
			? { url: server.url, headers: server.headers, timeout: server.timeoutMs / 1000 }
			: {
					command: server.command,
					args: server.args,
					env: server.env,
					cwd: server.cwd ?? "",
					timeout: server.timeoutMs / 1000,
				}),
	}));
	return {
		statePath: registryStatePath(root),
		sources: {
			statePath: registryStatePath(root),
			mcpConfigPaths: [join(stateDir(root), "mcp.json")].filter(existsSync),
			skillDirs: [
				...new Set([
					join(root, "skill"),
					join(root, "skills"),
					join(root, ".agents", "skills"),
					...config.skillPaths,
				]),
			].filter(existsSync),
			agentDir: join(stateDir(root), "agents"),
			toolSchemaPath: join(config.legacyRoot, "assets", "tools_schema.json"),
		},
		mcpServers,
		skills: listSkillEntries(root, config, state),
		agents: listAgentEntries(config, state),
		tools: listToolEntries(config, state),
	};
}

export function clearRegistryState(root: string, key: string, name: string): void {
	const state = readRegistryState(root);
	if (!isRecord(state[key])) return;
	delete state[key][name];
	if (Object.keys(state[key]).length === 0) delete state[key];
	atomicWriteJson(registryStatePath(root), state);
}
