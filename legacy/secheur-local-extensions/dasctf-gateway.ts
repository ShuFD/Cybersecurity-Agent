// dasctf-gateway.ts — strip OpenAI/Anthropic SDK path suffixes from
// `https://llm-gateway.dasctf.com/llm-gateway/proxy/e/<id>` requests.
//
// The DASCTF LLM gateway is a whole-endpoint proxy: the gateway URL is the
// complete request address; appending `/chat/completions`, `/responses`, or
// any other path suffix returns 404. Pi's OpenAI/Anthropic SDKs always
// append a suffix to `baseUrl`, so we wrap `globalThis.fetch` and rewrite
// the URL back to the bare gateway before forwarding.
//
// Install: `pi install npm:@secheur/dasctf-gateway` (or drop this package
// into `~/.pi/agent/extensions/` or `<project>/.pi/extensions/`).
//
// This wrapper is idempotent: it chains on top of any existing fetch wrapper
// (including the undici one installed by Pi's http-dispatcher.ts). The marker
// `(fetch as DasctfFetch).__dasctfGatewayWrapped` prevents double-wrapping.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GATEWAY_HOST = "llm-gateway.dasctf.com";
const GATEWAY_PATH = /^\/llm-gateway\/proxy\/e\/[A-Za-z0-9_-]+(?:\/+(?:chat\/completions|responses))?\/?$/u;

type DasctfFetch = typeof globalThis.fetch & { __dasctfGatewayWrapped?: boolean };

function rewriteGatewayUrl(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.host !== GATEWAY_HOST) return null;
	if (!GATEWAY_PATH.test(parsed.pathname)) return null;
	const stripped = parsed.pathname.replace(/\/+(?:chat\/completions|responses)\/?$/u, "").replace(/\/+$/u, "");
	if (stripped === parsed.pathname) return null;
	parsed.pathname = stripped;
	return parsed.toString();
}

function wrapFetch(): void {
	const current = globalThis.fetch as DasctfFetch;
	if (current.__dasctfGatewayWrapped) return;
	const inner: typeof globalThis.fetch = current.bind(globalThis);
	const wrapped: DasctfFetch = function dasctfGatewayFetch(input, init) {
		const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const rewritten = rewriteGatewayUrl(target);
		if (rewritten === null) {
			return inner(input as Request | string | URL, init);
		}
		if (typeof input === "string") return inner(rewritten, init);
		if (input instanceof URL) return inner(new Request(rewritten, input), init);
		return inner(new Request(rewritten, input), init);
	};
	wrapped.__dasctfGatewayWrapped = true;
	globalThis.fetch = wrapped;
}

export default function dasctfGateway(pi: ExtensionAPI): void {
	wrapFetch();
	pi.on("session_start", wrapFetch);
	pi.on("session_resume", wrapFetch);
	pi.on("session_fork", wrapFetch);
}