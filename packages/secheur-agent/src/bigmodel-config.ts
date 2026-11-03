export const DEFAULT_BIGMODEL_RESPONSES_ENDPOINT = "https://open.bigmodel.cn/api/v1/responses";
export const DEFAULT_BIGMODEL_MODEL = "glm-5.3";

export interface BigModelRouteConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
}

export function normalizeBigModelResponsesBaseUrl(endpoint: string): string {
	let parsed: URL;
	try {
		parsed = new URL(endpoint.trim());
	} catch {
		throw new Error("BIGMODEL_RESPONSES_ENDPOINT must be a valid HTTP(S) URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("BIGMODEL_RESPONSES_ENDPOINT must use HTTP or HTTPS");
	}
	parsed.pathname = parsed.pathname.replace(/\/responses\/?$/iu, "") || "/";
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/$/u, "");
}

export function resolveBigModelRoute(env: NodeJS.ProcessEnv = process.env): BigModelRouteConfig | undefined {
	const apiKey = env.BIGMODEL_API_KEY?.trim();
	if (!apiKey) return undefined;
	return {
		apiKey,
		baseUrl: normalizeBigModelResponsesBaseUrl(
			env.BIGMODEL_RESPONSES_ENDPOINT?.trim() || DEFAULT_BIGMODEL_RESPONSES_ENDPOINT,
		),
		model: env.BIGMODEL_MODEL?.trim() || DEFAULT_BIGMODEL_MODEL,
	};
}
