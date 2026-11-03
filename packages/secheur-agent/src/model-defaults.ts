import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const LEGACY_DEEPSEEK_BASE_URL = "https://loliapi.org";

function normalizeDeepSeekBaseUrl(value: string | undefined): string {
	const candidate = value?.trim();
	if (!candidate) return DEFAULT_DEEPSEEK_BASE_URL;
	return candidate.replace(/\/responses\/?$/u, "").replace(/\/+$/u, "");
}

function defaultModelCatalog(deepseekBaseUrl: string) {
	return {
		providers: {
			"secheur-deepseek": {
				baseUrl: deepseekBaseUrl,
				api: "openai-responses",
				models: [
					{
						id: "deepseek-v4-flash",
						name: "DeepSeek V4 Flash",
						api: "openai-responses",
						baseUrl: deepseekBaseUrl,
						reasoning: true,
						input: ["text"],
						contextWindow: 1_000_000,
						maxTokens: 384_000,
						cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
						thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
					},
				],
			},
			"secheur-glm": {
				baseUrl: "https://llm-gateway.dasctf.com/llm-gateway/proxy/e/H5Jx-bqJJQCkbZys",
				api: "openai-responses",
				models: [
					{
						id: "glm-5.3",
						name: "GLM 5.3",
						api: "openai-responses",
						baseUrl: "https://llm-gateway.dasctf.com/llm-gateway/proxy/e/H5Jx-bqJJQCkbZys",
						reasoning: true,
						input: ["text"],
						contextWindow: 1_000_000,
						maxTokens: 131_072,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high", max: "max" },
					},
				],
			},
		},
	} as const;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function migrateKnownModelDefaults(path: string, deepseekBaseUrl: string): void {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed) || !isRecord(parsed.providers)) return;
		let changed = false;
		const deepseekProvider = parsed.providers["secheur-deepseek"];
		if (isRecord(deepseekProvider)) {
			if (deepseekProvider.baseUrl === LEGACY_DEEPSEEK_BASE_URL) {
				deepseekProvider.baseUrl = deepseekBaseUrl;
				changed = true;
			}
			if (Array.isArray(deepseekProvider.models)) {
				for (const model of deepseekProvider.models) {
					if (!isRecord(model) || model.id !== "deepseek-v4-flash") continue;
					if (model.baseUrl === LEGACY_DEEPSEEK_BASE_URL) {
						model.baseUrl = deepseekBaseUrl;
						changed = true;
					}
				}
			}
		}
		const provider = parsed.providers["secheur-glm"];
		if (isRecord(provider) && Array.isArray(provider.models)) {
			const model = provider.models.find((entry) => isRecord(entry) && entry.id === "glm-5.3");
			if (isRecord(model) && model.contextWindow === 200_000) {
				model.contextWindow = 1_000_000;
				changed = true;
			}
		}
		if (changed) writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
	} catch {
		// Keep user-managed model catalogs untouched when they are invalid or unavailable.
	}
}

function firstEnvironmentValue(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

export function ensureDefaultModelCatalog(agentDir: string, env: NodeJS.ProcessEnv = process.env): void {
	const path = join(agentDir, "models.json");
	const deepseekBaseUrl = normalizeDeepSeekBaseUrl(env.SECHEUR_DEEPSEEK_BASE_URL);
	if (existsSync(path)) {
		migrateKnownModelDefaults(path, deepseekBaseUrl);
		return;
	}
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(defaultModelCatalog(deepseekBaseUrl), null, 2)}\n`, { mode: 0o600 });
}

function hasApiKey(value: unknown): boolean {
	return isRecord(value) && typeof value.key === "string" && value.key.trim().length > 0;
}

export function ensureEnvironmentAuth(agentDir: string, env: NodeJS.ProcessEnv): void {
	const path = join(agentDir, "auth.json");
	let auth: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (isRecord(parsed)) auth = { ...parsed };
		} catch {
			return;
		}
	}
	const deepseek = firstEnvironmentValue(env, ["SECHEUR_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"]);
	const glm = firstEnvironmentValue(env, ["SECHEUR_GLM_API_KEY", "GLM_API_KEY"]);
	let changed = false;
	if (deepseek && !hasApiKey(auth["secheur-deepseek"])) {
		auth["secheur-deepseek"] = { type: "api_key", key: deepseek };
		changed = true;
	}
	if (glm && !hasApiKey(auth["secheur-glm"])) {
		auth["secheur-glm"] = { type: "api_key", key: glm };
		changed = true;
	}
	if (!changed) return;
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
}
