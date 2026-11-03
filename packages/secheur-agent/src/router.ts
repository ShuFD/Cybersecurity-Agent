import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveBigModelRoute } from "./bigmodel-config.ts";

export type RouterTier = "high" | "medium" | "low";
export type RouterThinking = "off" | ThinkingLevel;

export interface RouterTierConfig {
	model: string;
	thinking: RouterThinking;
	fallbacks: string[];
}

export interface RouterProfile {
	high: RouterTierConfig;
	medium: RouterTierConfig;
	low: RouterTierConfig;
}

export interface SecHeurRouterConfig {
	defaultProfile: string;
	profiles: Record<string, RouterProfile>;
	rules: Array<{ matches: string | string[]; tier: RouterTier }>;
}

const DEEPSEEK_MODEL = "secheur-deepseek/deepseek-v4-flash";
const DEFAULT_PROFILE: RouterProfile = {
	high: { model: "secheur-glm/glm-5.3", thinking: "max", fallbacks: [DEEPSEEK_MODEL] },
	medium: { model: DEEPSEEK_MODEL, thinking: "max", fallbacks: [] },
	low: { model: DEEPSEEK_MODEL, thinking: "max", fallbacks: [] },
};

const DEFAULT_ROUTER_CONFIG: SecHeurRouterConfig = {
	defaultProfile: "auto",
	profiles: { auto: DEFAULT_PROFILE },
	rules: [],
};

const THINKING_LEVELS = new Set<RouterThinking>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const DEFAULT_ROUTER_REQUEST_TIMEOUT_MS = 120_000;
const DASCTF_GATEWAY_HOST = "llm-gateway.dasctf.com";
const DASCTF_GATEWAY_PATH = /^\/llm-gateway\/proxy\/e\/[A-Za-z0-9_-]+(?:\/+(?:chat\/completions|responses))?\/?$/u;
let gatewayFetchInstalled = false;

function installDascGatewayFetch(): void {
	if (gatewayFetchInstalled) return;
	const original = globalThis.fetch;
	globalThis.fetch = (input, init) => {
		let parsed: URL;
		try {
			parsed = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		} catch {
			return original(input, init);
		}
		if (parsed.host !== DASCTF_GATEWAY_HOST || !DASCTF_GATEWAY_PATH.test(parsed.pathname)) {
			return original(input, init);
		}
		const stripped = parsed.pathname.replace(/\/(?:chat\/completions|responses)\/?$/u, "").replace(/\/+$/u, "");
		if (stripped === parsed.pathname) return original(input, init);
		parsed.pathname = stripped;
		if (typeof input === "string" || input instanceof URL) return original(parsed.toString(), init);
		return original(new Request(parsed.toString(), input), init);
	};
	gatewayFetchInstalled = true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function routerTier(value: unknown): RouterTier | undefined {
	return value === "high" || value === "medium" || value === "low" ? value : undefined;
}

function thinking(value: unknown, fallback: RouterThinking): RouterThinking {
	return typeof value === "string" && THINKING_LEVELS.has(value as RouterThinking)
		? (value as RouterThinking)
		: fallback;
}

function modelReference(value: unknown, fallback: string): string {
	const candidate = text(value);
	return candidate.includes("/") ? candidate : fallback;
}

function tierConfig(value: unknown, fallback: RouterTierConfig): RouterTierConfig {
	if (!isRecord(value)) return { ...fallback, fallbacks: [...fallback.fallbacks] };
	const fallbacks = Array.isArray(value.fallbacks)
		? value.fallbacks.flatMap((item) => {
				const candidate = text(item);
				return candidate.includes("/") ? [candidate] : [];
			})
		: [...fallback.fallbacks];
	return {
		model: modelReference(value.model, fallback.model),
		thinking: thinking(value.thinking, fallback.thinking),
		fallbacks,
	};
}

export function defaultSecHeurRouterConfig(): SecHeurRouterConfig {
	return {
		defaultProfile: DEFAULT_ROUTER_CONFIG.defaultProfile,
		profiles: {
			auto: {
				high: { ...DEFAULT_PROFILE.high, fallbacks: [...DEFAULT_PROFILE.high.fallbacks] },
				medium: { ...DEFAULT_PROFILE.medium, fallbacks: [] },
				low: { ...DEFAULT_PROFILE.low, fallbacks: [] },
			},
		},
		rules: [],
	};
}

export function loadSecHeurRouterConfig(projectRoot: string): SecHeurRouterConfig {
	const fallback = defaultSecHeurRouterConfig();
	const path = join(projectRoot, ".pi", "model-router.json");
	if (!existsSync(path)) return fallback;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed)) return fallback;
		const profiles: Record<string, RouterProfile> = {};
		const rawProfiles = isRecord(parsed.profiles) ? parsed.profiles : {};
		for (const [name, rawProfile] of Object.entries(rawProfiles)) {
			const profile = isRecord(rawProfile) ? rawProfile : {};
			profiles[name] = {
				high: tierConfig(profile.high, DEFAULT_PROFILE.high),
				medium: tierConfig(profile.medium, DEFAULT_PROFILE.medium),
				low: tierConfig(profile.low, DEFAULT_PROFILE.low),
			};
		}
		const rules =
			isRecord(parsed) && Array.isArray(parsed.rules)
				? parsed.rules.flatMap((rawRule) => {
						if (!isRecord(rawRule)) return [];
						const tier = routerTier(rawRule.tier);
						const matches = Array.isArray(rawRule.matches)
							? rawRule.matches.flatMap((item) => (text(item) ? [text(item)] : []))
							: text(rawRule.matches);
						if (!tier || (Array.isArray(matches) ? matches.length === 0 : !matches)) return [];
						return [{ matches, tier }];
					})
				: [];
		const defaultProfile = text(parsed.defaultProfile) || fallback.defaultProfile;
		return {
			defaultProfile: profiles[defaultProfile] ? defaultProfile : fallback.defaultProfile,
			profiles: Object.keys(profiles).length > 0 ? profiles : fallback.profiles,
			rules,
		};
	} catch {
		return fallback;
	}
}

function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.map((part) => {
			if (!isRecord(part)) return "";
			return text(part.text) || text(part.thinking) || "";
		})
		.filter(Boolean)
		.join("\n");
}

function promptText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message.role === "user") return contentText(message.content).toLowerCase();
	}
	return "";
}

function matchesRule(prompt: string, value: string): boolean {
	try {
		return new RegExp(value, "iu").test(prompt);
	} catch {
		return prompt.includes(value.toLowerCase());
	}
}

export function chooseSecHeurRouterTier(context: Context, config: SecHeurRouterConfig): RouterTier {
	const prompt = promptText(context);
	for (const rule of config.rules) {
		const values = Array.isArray(rule.matches) ? rule.matches : [rule.matches];
		if (values.some((value) => matchesRule(prompt, value))) return rule.tier;
	}
	if (/(?:pwn|exploit|payload|shellcode|rop|reverse|vulnerabil|crypto|解题|利用|逆向|漏洞|攻击|flag)/iu.test(prompt))
		return "high";
	if (/(?:implement|fix|debug|patch|refactor|code|test|实现|修复|调试|编写|代码)/iu.test(prompt)) return "medium";
	return prompt.split(/\s+/u).filter(Boolean).length <= 12 ? "low" : "medium";
}

function parseModelReference(value: string): { provider: string; modelId: string } {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) throw new Error(`Invalid routed model reference: ${value}`);
	return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

function errorMessage(model: Model<Api>, message: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}

function eventHasContent(event: AssistantMessageEvent): boolean {
	return (
		event.type === "text_delta" ||
		event.type === "thinking_delta" ||
		event.type === "toolcall_delta" ||
		event.type === "toolcall_end"
	);
}

async function delegate(
	registry: ExtensionContext["modelRegistry"],
	modelRef: string,
	context: Context,
	options: SimpleStreamOptions | undefined,
	env: NodeJS.ProcessEnv,
): Promise<AssistantMessageEvent[]> {
	const parsed = parseModelReference(modelRef);
	const model = registry.find(parsed.provider, parsed.modelId);
	if (!model) throw new Error(`Routed model is unavailable: ${modelRef}`);
	const bigModel = parsed.provider === "secheur-glm" ? resolveBigModelRoute(env) : undefined;
	if (bigModel && model.api !== "openai-responses") {
		throw new Error(`BigModel routing requires an openai-responses model, got ${model.api}`);
	}
	const timeoutMs = Math.max(
		1_000,
		Math.min(routerRequestTimeoutMs(env), options?.timeoutMs ?? Number.POSITIVE_INFINITY),
	);
	const timeoutController = new AbortController();
	const timer = setTimeout(() => {
		timeoutController.abort(new Error(`Model request timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	const signal = options?.signal
		? AbortSignal.any([options.signal, timeoutController.signal])
		: timeoutController.signal;
	let routedModel = model;
	let requestOptions: SimpleStreamOptions = { ...options, signal, timeoutMs };
	try {
		if (bigModel) {
			routedModel = { ...model, baseUrl: bigModel.baseUrl, id: bigModel.model };
			requestOptions = { ...requestOptions, apiKey: bigModel.apiKey };
		} else {
			const auth = await registry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(`Authentication failed for ${modelRef}: ${auth.error}`);
			routedModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
			requestOptions = {
				...requestOptions,
				...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
				...(auth.headers ? { headers: auth.headers } : {}),
			};
		}
		const delegated = streamSimple(routedModel, context, {
			...requestOptions,
			...(model.reasoning ? { reasoning: "max" as const } : {}),
		});
		const events: AssistantMessageEvent[] = [];
		let contentReceived = false;
		let completed = false;
		for await (const event of delegated) {
			if (eventHasContent(event)) contentReceived = true;
			if (event.type === "error") {
				if (!contentReceived) throw new Error(event.error.errorMessage ?? `Model failed: ${modelRef}`);
				throw new Error(event.error.errorMessage ?? `Model failed after partial output: ${modelRef}`);
			}
			events.push(event);
			if (event.type === "done") completed = true;
		}
		if (!completed) throw new Error(`Model stream ended without a result: ${modelRef}`);
		return events;
	} finally {
		clearTimeout(timer);
	}
}

export interface SecHeurRouterOptions {
	projectRoot?: string;
	env?: NodeJS.ProcessEnv;
	taskKind?: string | null;
}

export function selectSecHeurRouterTier(
	context: Context,
	config: SecHeurRouterConfig,
	taskKind?: string | null,
): RouterTier {
	return taskKind === "ctf" ? "high" : chooseSecHeurRouterTier(context, config);
}

function routerRequestTimeoutMs(env: NodeJS.ProcessEnv): number {
	const configured = Number(env.SECHEUR_MODEL_REQUEST_TIMEOUT_MS);
	return Number.isFinite(configured) && configured >= 1_000
		? Math.trunc(configured)
		: DEFAULT_ROUTER_REQUEST_TIMEOUT_MS;
}

export function registerSecHeurRouter(pi: ExtensionAPI, options: SecHeurRouterOptions = {}): void {
	const projectRoot = options.projectRoot ?? process.cwd();
	const env = options.env ?? process.env;
	const config = loadSecHeurRouterConfig(projectRoot);
	const profile = config.profiles[config.defaultProfile] ?? DEFAULT_PROFILE;
	let registry: ExtensionContext["modelRegistry"] | undefined;

	installDascGatewayFetch();
	if (typeof pi.registerProvider !== "function") return;
	pi.unregisterProvider?.("router");
	pi.registerProvider("router", {
		name: "SecHeur model router",
		baseUrl: "router://local",
		apiKey: "secheur-router",
		api: "secheur-router",
		models: [
			...Object.keys(config.profiles).map((id) => ({
				id,
				name: `SecHeur Router ${id}`,
				reasoning: true,
				thinkingLevelMap: {
					off: null,
					minimal: "max",
					low: "max",
					medium: "max",
					high: "max",
					xhigh: "max",
					max: "max",
				},
				input: ["text", "image"] as ("text" | "image")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 128_000,
			})),
		],
		streamSimple(model, context, streamOptions) {
			const output = createAssistantMessageEventStream();
			void (async () => {
				try {
					if (!registry) throw new Error("SecHeur router is not attached to a Pi session");
					const selectedTier = selectSecHeurRouterTier(context, config, options.taskKind);
					const routedProfile = config.profiles[model.id] ?? profile;
					const selected = routedProfile[selectedTier];
					const candidates = [selected.model, ...selected.fallbacks];
					let lastError = "No routed model was available";
					for (const candidate of candidates) {
						try {
							const events = await delegate(
								registry,
								candidate,
								context,
								{
									...streamOptions,
									reasoning: selected.thinking === "off" ? streamOptions?.reasoning : "max",
								},
								env,
							);
							for (const event of events) output.push(event);
							return;
						} catch (error) {
							lastError = error instanceof Error ? error.message : String(error);
						}
					}
					output.push({
						type: "error",
						reason: "error",
						error: errorMessage(model, `${selectedTier} route failed: ${lastError}`),
					});
				} catch (error) {
					output.push({
						type: "error",
						reason: "error",
						error: errorMessage(model, error instanceof Error ? error.message : String(error)),
					});
				} finally {
					output.end();
				}
			})();
			return output;
		},
	});

	pi.on("session_start", (_event, context) => {
		installDascGatewayFetch();
		registry = context.modelRegistry;
	});
	pi.on("session_shutdown", () => {
		registry = undefined;
	});
}
