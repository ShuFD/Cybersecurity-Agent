import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { createProvider, type Provider } from "../models.ts";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "./cloudflare-ai-gateway.models.ts";
import { cloudflareAIGatewayAuth } from "./cloudflare-auth.ts";
import { cloudflareStreams } from "./cloudflare-stream.ts";

export function cloudflareAIGatewayProvider(): Provider<
	"anthropic-messages" | "openai-completions" | "openai-responses"
> {
	// The TApi union is explicit because CLOUDFLARE_AI_GATEWAY_MODELS derives
	// its api types from the hydrated catalog groups. Upstream model data can
	// temporarily drop a group (e.g. no workers-ai passthrough entries), which
	// would otherwise narrow the inferred TApi and make the registered
	// "openai-completions" implementation an excess property at compile time.
	return createProvider<"anthropic-messages" | "openai-completions" | "openai-responses">({
		id: "cloudflare-ai-gateway",
		name: "Cloudflare AI Gateway",
		auth: { apiKey: cloudflareAIGatewayAuth() },
		models: Object.values(CLOUDFLARE_AI_GATEWAY_MODELS),
		api: {
			"anthropic-messages": cloudflareStreams(anthropicMessagesApi()),
			"openai-completions": cloudflareStreams(openAICompletionsApi()),
			"openai-responses": cloudflareStreams(openAIResponsesApi()),
		},
	});
}
