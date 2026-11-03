#!/usr/bin/env node
// Minimal offline MCP fixture for `secheur self-test`.
// Protocol: JSON-RPC 2.0 over newline-delimited stdio (one JSON object per line).
// Tools exposed:
//   - echo: returns text content and a structuredContent envelope.
//   - status: returns a small JSON payload plus structuredContent.
import { createInterface } from "node:readline";

const TOOLS = [
	{
		name: "echo",
		description: "Echo the supplied text. Returns text content and structuredContent.",
		inputSchema: {
			type: "object",
			properties: {
				text: { type: "string", description: "Text to echo back." },
			},
			required: ["text"],
			additionalProperties: false,
		},
	},
	{
		name: "status",
		description: "Return a status payload with structuredContent for verification.",
		inputSchema: {
			type: "object",
			properties: {
				label: { type: "string", description: "Optional label for the status payload." },
			},
			additionalProperties: false,
		},
	},
];

function reply(id, result) {
	return new Promise((resolve) => {
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`, () => resolve());
	});
}

function replyError(id, code, message) {
	return reply(id, { code, message });
}

async function handle(request) {
	const id = request.id;
	if (typeof id !== "number" && typeof id !== "string") return;
	switch (request.method) {
		case "initialize":
			await reply(id, {
				protocolVersion: "2025-11-25",
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "secheur-self-test-fixture", version: "0.0.1" },
			});
			return;
		case "tools/list":
			await reply(id, { tools: TOOLS });
			return;
		case "tools/call": {
			const params = request.params ?? {};
			const toolName = typeof params.name === "string" ? params.name : "";
			const args = params.arguments ?? {};
			if (toolName === "echo") {
				const text = typeof args.text === "string" ? args.text : "";
				await reply(id, {
					content: [{ type: "text", text: `echo: ${text}` }],
					structuredContent: { echoed: text, ts: Date.now() },
				});
				return;
			}
			if (toolName === "status") {
				const label = typeof args.label === "string" ? args.label : "ok";
				await reply(id, {
					content: [{ type: "text", text: `status: ${label}` }],
					structuredContent: { label, healthy: true, ts: Date.now() },
				});
				return;
			}
			await replyError(id, -32602, `unknown tool: ${toolName}`);
			return;
		}
		case "notifications/initialized":
			return;
		default:
			await replyError(id, -32601, `method not found: ${request.method ?? ""}`);
	}
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let request;
	try {
		request = JSON.parse(trimmed);
	} catch {
		return;
	}
	void handle(request);
});
reader.on("close", () => {
	process.exit(0);
});
