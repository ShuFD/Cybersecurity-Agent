import { type CompetitionPlatformAdapter, CtfLabAdapter, SlabCompetitionAdapter } from "./competition-adapters.ts";
import { competitionEnvPath, ctfdAgentApiUrl, SlabAgentApi } from "./competition-api.ts";
import type { SecHeurConfig } from "./config.ts";

export type CompetitionAdapterPlatform = "ctfd" | "slab";
export type CompetitionAdapterTransport = "agent_api" | "ctfd_api";

export interface CompetitionAdapterRuntimeConfig {
	platform: CompetitionAdapterPlatform;
	transport: CompetitionAdapterTransport;
	baseUrl?: string;
	agentApiUrl?: string;
	environmentGatewayUrl?: string;
	authScheme?: "Token" | "Bearer";
	accessKey?: string;
	apiToken?: string;
	matchId?: string | number;
	submitMode?: "full" | "inner";
}

export interface CompetitionAdapterConfigPatch {
	platform?: CompetitionAdapterPlatform;
	transport?: CompetitionAdapterTransport;
	baseUrl?: string;
	agentApiUrl?: string;
	environmentGatewayUrl?: string;
	authScheme?: "Token" | "Bearer";
	accessKey?: string;
	apiToken?: string;
	accessKeyEnv?: string;
	apiTokenEnv?: string;
	useEnvironmentCredentials?: boolean;
	force?: boolean;
}

export interface CompetitionAdapterSummary {
	platform: CompetitionAdapterPlatform;
	transport: CompetitionAdapterTransport;
	baseUrl?: string;
	agentApiUrl?: string;
	environmentGatewayUrl?: string;
	credentials: {
		accessKeyConfigured: boolean;
		apiTokenConfigured: boolean;
	};
}

export interface CompetitionAdapterBuild {
	adapter: CompetitionPlatformAdapter;
	attachmentApi: SlabAgentApi;
	config: CompetitionAdapterRuntimeConfig;
	summary: CompetitionAdapterSummary;
}

export interface CompetitionAdapterFactoryOptions {
	config: SecHeurConfig;
	env: NodeJS.ProcessEnv;
	maxEnvironmentSlots: number;
	slabApi?: SlabAgentApi;
	reuseSlabApi?: boolean;
	fetchImpl?: typeof fetch;
}

const ACCESS_KEY_ENV_NAMES = ["CTFD_AGENT_ACCESS_KEY", "SLAB_AGENT_ACCESSKEY"] as const;
const API_TOKEN_ENV_NAMES = ["CTFD_API_TOKEN", "CTF_LAB_TOKEN"] as const;

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function firstEnvironmentValue(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = text(env[name]);
		if (value) return value;
	}
	return undefined;
}

function normalizeHttpUrl(value: string, field: string): string {
	let candidate = value.trim();
	if (!candidate) throw new Error(`${field} must not be empty`);
	if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(candidate)) candidate = `http://${candidate}`;
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		throw new Error(`${field} must be a valid HTTP URL`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${field} must use HTTP or HTTPS`);
	if (parsed.username || parsed.password) throw new Error(`${field} must not contain embedded credentials`);
	return candidate.replace(/\/+$/u, "");
}

function optionalUrl(value: string | undefined, field: string): string | undefined {
	return value === undefined ? undefined : normalizeHttpUrl(value, field);
}

function credentialFromEnvironment(
	env: NodeJS.ProcessEnv,
	name: string | undefined,
	allowed: readonly string[],
	field: string,
): string | undefined {
	if (name === undefined) return undefined;
	if (!allowed.includes(name)) throw new Error(`${field} must reference an approved credential environment variable`);
	return text(env[name]);
}

function validatePlatform(value: unknown): CompetitionAdapterPlatform {
	if (value === "ctfd" || value === "slab") return value;
	throw new Error("platform must be ctfd or slab");
}

function validateTransport(value: unknown): CompetitionAdapterTransport {
	if (value === "agent_api" || value === "ctfd_api") return value;
	throw new Error("transport must be agent_api or ctfd_api");
}

export function competitionAdapterConfigFromEnvironment(env: NodeJS.ProcessEnv): CompetitionAdapterRuntimeConfig {
	const ctfdUrl = text(env.CTFD_URL) || text(env.CTF_LAB_URL);
	if (ctfdUrl) {
		const accessKey = text(env.CTFD_AGENT_ACCESS_KEY);
		return {
			platform: "ctfd",
			transport: accessKey ? "agent_api" : "ctfd_api",
			baseUrl: normalizeHttpUrl(ctfdUrl, "CTFD_URL"),
			...(text(env.CTFD_AGENT_API_URL)
				? { agentApiUrl: normalizeHttpUrl(text(env.CTFD_AGENT_API_URL), "CTFD_AGENT_API_URL") }
				: {}),
			...(text(env.CTF_LAB_GATEWAY_URL)
				? { environmentGatewayUrl: normalizeHttpUrl(text(env.CTF_LAB_GATEWAY_URL), "CTF_LAB_GATEWAY_URL") }
				: {}),
			...(env.CTFD_AUTH_SCHEME === "Bearer" ? { authScheme: "Bearer" as const } : {}),
			...(accessKey ? { accessKey } : {}),
			...(text(env.CTFD_API_TOKEN) || text(env.CTF_LAB_TOKEN)
				? { apiToken: text(env.CTFD_API_TOKEN) || text(env.CTF_LAB_TOKEN) }
				: {}),
		};
	}
	const slabHost = text(env.SLAB_MATCH_HOST);
	const slabAccessKey = text(env.SLAB_AGENT_ACCESSKEY);
	return {
		platform: "slab",
		transport: "agent_api",
		...(slabHost ? { baseUrl: normalizeHttpUrl(slabHost, "SLAB_MATCH_HOST") } : {}),
		...(slabAccessKey ? { accessKey: slabAccessKey } : {}),
		...(text(env.SLAB_MATCH_ID) ? { matchId: text(env.SLAB_MATCH_ID) } : {}),
		submitMode: env.SLAB_FLAG_SUBMISSION_MODE === "full" ? "full" : "inner",
	};
}

export function resolveCompetitionAdapterConfig(
	patch: CompetitionAdapterConfigPatch,
	current: CompetitionAdapterRuntimeConfig,
	env: NodeJS.ProcessEnv,
): CompetitionAdapterRuntimeConfig {
	const platform = patch.platform === undefined ? current.platform : validatePlatform(patch.platform);
	const platformChanged = platform !== current.platform;
	const accessKeyFromEnv = credentialFromEnvironment(env, patch.accessKeyEnv, ACCESS_KEY_ENV_NAMES, "accessKeyEnv");
	const apiTokenFromEnv = credentialFromEnvironment(env, patch.apiTokenEnv, API_TOKEN_ENV_NAMES, "apiTokenEnv");
	const accessKey = patch.useEnvironmentCredentials
		? firstEnvironmentValue(env, ACCESS_KEY_ENV_NAMES)
		: patch.accessKeyEnv === undefined
			? patch.accessKey === undefined
				? current.accessKey
				: text(patch.accessKey)
			: accessKeyFromEnv;
	const apiToken = patch.useEnvironmentCredentials
		? firstEnvironmentValue(env, API_TOKEN_ENV_NAMES)
		: patch.apiTokenEnv === undefined
			? patch.apiToken === undefined
				? current.apiToken
				: text(patch.apiToken)
			: apiTokenFromEnv;
	let transport = patch.transport === undefined ? current.transport : validateTransport(patch.transport);
	const credentialSwitchRequested =
		patch.accessKey !== undefined || patch.accessKeyEnv !== undefined || patch.useEnvironmentCredentials === true;
	if (patch.transport === undefined && platform === "ctfd" && (platformChanged || credentialSwitchRequested))
		transport = accessKey ? "agent_api" : "ctfd_api";
	if (platform === "slab") transport = "agent_api";
	if (platform === "slab" && patch.transport === "ctfd_api")
		throw new Error("slab platform only supports the agent API transport");
	const baseUrl = patch.baseUrl === undefined ? current.baseUrl : normalizeHttpUrl(patch.baseUrl, "baseUrl");
	const agentApiUrl =
		patch.agentApiUrl === undefined ? current.agentApiUrl : normalizeHttpUrl(patch.agentApiUrl, "agentApiUrl");
	const environmentGatewayUrl =
		patch.environmentGatewayUrl === undefined
			? current.environmentGatewayUrl
			: optionalUrl(patch.environmentGatewayUrl, "environmentGatewayUrl");
	const authScheme = patch.authScheme ?? current.authScheme;
	if (authScheme !== undefined && authScheme !== "Token" && authScheme !== "Bearer")
		throw new Error("authScheme must be Token or Bearer");
	if (platform === "ctfd" && !baseUrl) throw new Error("baseUrl is required for the ctfd platform");
	if (transport === "agent_api" && platform === "ctfd" && !accessKey)
		throw new Error("agent_api transport requires an access key or an approved credential environment variable");
	return {
		platform,
		transport,
		...(baseUrl ? { baseUrl } : {}),
		...(agentApiUrl ? { agentApiUrl } : {}),
		...(environmentGatewayUrl ? { environmentGatewayUrl } : {}),
		...(authScheme ? { authScheme } : {}),
		...(accessKey ? { accessKey } : {}),
		...(apiToken ? { apiToken } : {}),
		...(current.matchId !== undefined ? { matchId: current.matchId } : {}),
		...(current.submitMode ? { submitMode: current.submitMode } : {}),
	};
}

function summaryFor(config: CompetitionAdapterRuntimeConfig, attachmentApi: SlabAgentApi): CompetitionAdapterSummary {
	const agentApiUrl =
		config.platform === "ctfd" && config.transport === "agent_api"
			? (config.agentApiUrl ?? (config.baseUrl ? ctfdAgentApiUrl(config.baseUrl) : undefined))
			: undefined;
	return {
		platform: config.platform,
		transport: config.transport,
		...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
		...(agentApiUrl ? { agentApiUrl } : {}),
		...(config.environmentGatewayUrl ? { environmentGatewayUrl: config.environmentGatewayUrl } : {}),
		credentials: {
			accessKeyConfigured: config.transport === "agent_api" && attachmentApi.isConfigured(),
			apiTokenConfigured: config.transport === "ctfd_api" && Boolean(config.apiToken),
		},
	};
}

export function createCompetitionAdapter(
	config: CompetitionAdapterRuntimeConfig,
	options: CompetitionAdapterFactoryOptions,
): CompetitionAdapterBuild {
	const maxEnvironmentSlots = Math.max(1, Math.trunc(options.maxEnvironmentSlots));
	if (config.platform === "ctfd") {
		if (!config.baseUrl) throw new Error("baseUrl is required for the ctfd platform");
		if (config.transport === "agent_api") {
			const attachmentApi = new SlabAgentApi({
				baseUrl: config.agentApiUrl ?? ctfdAgentApiUrl(config.baseUrl),
				accessKey: config.accessKey,
				matchId: config.matchId,
				env: options.env,
				recoverAfterSubmit: false,
				...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
			});
			return {
				adapter: new SlabCompetitionAdapter({
					api: attachmentApi,
					platform: "ctfd",
					maxEnvironmentSlots,
				}),
				attachmentApi,
				config,
				summary: summaryFor(config, attachmentApi),
			};
		}
		const attachmentApi = options.slabApi ?? new SlabAgentApi({ env: options.env, recoverAfterSubmit: false });
		return {
			adapter: new CtfLabAdapter({
				baseUrl: config.baseUrl,
				token: config.apiToken ?? "",
				authScheme: config.authScheme,
				environmentGatewayUrl: config.environmentGatewayUrl,
				maxEnvironmentSlots,
				...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
			}),
			attachmentApi,
			config,
			summary: summaryFor(config, attachmentApi),
		};
	}

	const attachmentApi =
		options.reuseSlabApi && options.slabApi
			? options.slabApi
			: new SlabAgentApi({
					baseUrl: config.baseUrl,
					accessKey: config.accessKey,
					matchId: config.matchId,
					env: options.env,
					competitionEnvFile: competitionEnvPath(options.config, options.env),
					recoverAfterSubmit: false,
					...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
				});
	return {
		adapter: new SlabCompetitionAdapter({
			api: attachmentApi,
			platform: "slab",
			maxEnvironmentSlots,
			submitMode: config.submitMode,
		}),
		attachmentApi,
		config,
		summary: summaryFor(config, attachmentApi),
	};
}
