import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { request as httpRequest, type RequestOptions } from "node:http";
import { type RequestOptions as HttpsRequestOptions, request as httpsRequest } from "node:https";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { URL as NodeURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import type { McpServerConfig } from "./config.ts";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

// Node's `undici.fetch` ignores explicit `Host` headers and always derives the
// Host from the URL host. MCP servers gated by TransportSecurityMiddleware
// reject mismatched Host with HTTP 421. To bypass we use node's `http`/`https`
// modules directly — these honor the Host header verbatim at the HTTP layer.
// Returns the parsed body (string) or throws on transport error.
async function httpRequestRaw(
	url: string,
	headers: Record<string, string>,
	body: string,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
	return new Promise((resolve, reject) => {
		let parsed: NodeURL;
		try {
			parsed = new NodeURL(url);
		} catch (err) {
			reject(err);
			return;
		}
		const isHttps = parsed.protocol === "https:";
		const lib = isHttps ? httpsRequest : httpRequest;
		const opts: RequestOptions | HttpsRequestOptions = {
			method: "POST",
			protocol: parsed.protocol,
			hostname: parsed.hostname,
			port: parsed.port || (isHttps ? 443 : 80),
			path: `${parsed.pathname}${parsed.search || ""}`,
			headers,
		};
		const req = lib(opts, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				resolve({
					status: res.statusCode ?? 0,
					headers: res.headers as Record<string, string | string[] | undefined>,
					text: Buffer.concat(chunks).toString("utf-8"),
				});
			});
			res.on("error", reject);
		});
		req.on("error", reject);
		if (signal.aborted) {
			req.destroy(new Error("aborted"));
			reject(new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			req.destroy(new Error(`MCP HTTP timeout after ${timeoutMs}ms`));
			reject(new Error(`MCP HTTP timeout after ${timeoutMs}ms`));
		}, timeoutMs);
		req.on("close", () => clearTimeout(timer));
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			req.destroy(new Error("aborted"));
			reject(new Error("aborted"));
		});
		req.end(body);
	});
}

interface JsonRpcResponse {
	jsonrpc?: string;
	id?: number | string | null;
	result?: JsonValue;
	error?: {
		code?: number;
		message?: string;
		data?: JsonValue;
	};
}

export interface McpRemoteTool {
	name: string;
	description: string;
	inputSchema: TSchema;
}

export interface McpExposedTool extends McpRemoteTool {
	exposedName: string;
	serverName: string;
}

export interface McpDiagnostic {
	status: "connected" | "error";
	transport: "http" | "stdio";
	endpoint: string;
	tools: string[];
	message?: string;
}

export interface McpToolResult {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	isError?: boolean;
	structuredContent?: JsonValue;
}

export interface LegacyMcpToolSchema {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: TSchema;
	};
}

interface McpConnection {
	initialize(signal?: AbortSignal): Promise<void>;
	listTools(signal?: AbortSignal): Promise<McpRemoteTool[]>;
	callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult>;
	close(): Promise<void>;
}

interface PendingStdioRequest {
	resolve: (value: JsonValue | undefined) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
}

const MCP_TOOL_NAME_MAX_LENGTH = 64;
const FALLBACK_PARAMETERS = Type.Object({}, { additionalProperties: true });

function terminateChild(child: ChildProcessWithoutNullStreams): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	const forceKill = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}, 1_000);
	forceKill.unref();
	child.once("exit", () => clearTimeout(forceKill));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isRecord(value) && Object.values(value).every(isJsonValue);
}

function asJsonValue(value: unknown): JsonValue | undefined {
	return isJsonValue(value) ? value : undefined;
}

function toJsonRpcResponse(value: unknown): JsonRpcResponse | undefined {
	if (!isRecord(value)) return undefined;
	const error = isRecord(value.error)
		? {
				code: typeof value.error.code === "number" ? value.error.code : undefined,
				message: typeof value.error.message === "string" ? value.error.message : undefined,
				data: asJsonValue(value.error.data),
			}
		: undefined;
	const id = typeof value.id === "number" || typeof value.id === "string" || value.id === null ? value.id : undefined;
	return {
		jsonrpc: typeof value.jsonrpc === "string" ? value.jsonrpc : undefined,
		id,
		result: asJsonValue(value.result),
		error,
	};
}

function rpcResult(response: JsonRpcResponse): JsonValue | undefined {
	if (response.error) {
		throw new Error(`MCP error ${response.error.code ?? "unknown"}: ${response.error.message ?? "Unknown error"}`);
	}
	return response.result;
}

function parseSse(text: string): unknown[] {
	const messages: unknown[] = [];
	let dataLines: string[] = [];
	const flush = () => {
		if (dataLines.length === 0) return;
		const data = dataLines.join("\n");
		dataLines = [];
		if (data.trim() === "[DONE]") return;
		messages.push(JSON.parse(data));
	};
	for (const rawLine of text.split(/\r?\n/)) {
		if (!rawLine) {
			flush();
			continue;
		}
		if (rawLine.startsWith(":")) continue;
		const separator = rawLine.indexOf(":");
		const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
		if (field !== "data") continue;
		let value = separator === -1 ? "" : rawLine.slice(separator + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		dataLines.push(value);
	}
	flush();
	return messages;
}

function findResponse(value: unknown, id: number): JsonRpcResponse | undefined {
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findResponse(item, id);
			if (found) return found;
		}
		return undefined;
	}
	const response = toJsonRpcResponse(value);
	return response?.id === id ? response : undefined;
}

function createRequestSignal(
	timeoutMs: number,
	parent?: AbortSignal,
): {
	signal: AbortSignal;
	dispose: () => void;
} {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`MCP request timed out after ${timeoutMs}ms`)), timeoutMs);
	timer.unref();
	const onAbort = () => controller.abort(parent?.reason);
	if (parent?.aborted) onAbort();
	else parent?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onAbort);
		},
	};
}

function normalizeToolSchema(value: unknown): TSchema {
	if (!isRecord(value) || value.type !== "object") return FALLBACK_PARAMETERS;
	return value as TSchema;
}

function parseToolList(value: JsonValue | undefined): McpRemoteTool[] {
	if (!isRecord(value) || !Array.isArray(value.tools)) return [];
	return value.tools.flatMap((item) => {
		if (!isRecord(item) || typeof item.name !== "string" || !item.name) return [];
		return [
			{
				name: item.name,
				description: typeof item.description === "string" ? item.description : "",
				inputSchema: normalizeToolSchema(item.inputSchema),
			},
		];
	});
}

function parseToolResult(value: JsonValue | undefined): McpToolResult {
	if (!isRecord(value) || !Array.isArray(value.content)) {
		return { content: [{ type: "text", text: JSON.stringify(value ?? null) }] };
	}
	const content: McpToolResult["content"] = [];
	for (const item of value.content) {
		if (!isRecord(item)) continue;
		if (item.type === "text" && typeof item.text === "string") {
			content.push({ type: "text", text: item.text });
		} else if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
			content.push({ type: "image", data: item.data, mimeType: item.mimeType });
		} else {
			content.push({ type: "text", text: JSON.stringify(item) });
		}
	}
	if (content.length === 0) content.push({ type: "text", text: "MCP tool returned no content" });
	const structuredContent = asJsonValue(value.structuredContent);
	return {
		content,
		isError: value.isError === true,
		...(structuredContent === undefined ? {} : { structuredContent }),
	};
}

class McpHttpConnection implements McpConnection {
	private readonly config: Extract<McpServerConfig, { transport: "http" }>;
	private nextId = 1;
	private sessionId?: string;
	private protocolVersion: string;

	constructor(config: Extract<McpServerConfig, { transport: "http" }>) {
		this.config = config;
		this.protocolVersion = config.protocolVersion;
	}

	private async post(method: string, params: JsonValue, expectResponse: boolean, signal?: AbortSignal) {
		const id = expectResponse ? this.nextId++ : undefined;
		const requestSignal = createRequestSignal(this.config.timeoutMs, signal);
		try {
			const headers: Record<string, string> = {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
				"MCP-Protocol-Version": this.protocolVersion,
				...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
				...this.config.headers,
			};
			const body = JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params });
			const response = await httpRequestRaw(
				this.config.url,
				headers,
				body,
				requestSignal.signal,
				this.config.timeoutMs,
			);
			const responseSessionId = (response.headers["mcp-session-id"] ?? response.headers["Mcp-Session-Id"]) as
				| string
				| undefined;
			if (responseSessionId) this.sessionId = responseSessionId;
			const text = response.text;
			if (response.status >= 400) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
			if (!expectResponse) return undefined;
			if (!text.trim()) throw new Error(`MCP HTTP response for id ${id} was empty`);
			const contentType = (response.headers["content-type"] ?? "") as string;
			const parsed: unknown = contentType.toLowerCase().includes("text/event-stream")
				? parseSse(text)
				: JSON.parse(text);
			const message = findResponse(parsed, id as number);
			if (!message) throw new Error(`MCP HTTP response missing JSON-RPC id ${id}`);
			return rpcResult(message);
		} finally {
			requestSignal.dispose();
		}
	}

	async initialize(signal?: AbortSignal): Promise<void> {
		const result = await this.post(
			"initialize",
			{
				protocolVersion: this.protocolVersion,
				capabilities: {},
				clientInfo: { name: "secheur-agent", version: "0.1.0" },
			},
			true,
			signal,
		);
		if (isRecord(result) && typeof result.protocolVersion === "string") {
			this.protocolVersion = result.protocolVersion;
		}
		await this.post("notifications/initialized", {}, false, signal);
	}

	async listTools(signal?: AbortSignal): Promise<McpRemoteTool[]> {
		return parseToolList(await this.post("tools/list", {}, true, signal));
	}

	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
		const safeArgs = asJsonValue(args);
		if (!safeArgs || !isRecord(safeArgs)) throw new Error("MCP tool arguments must be JSON-serializable");
		return parseToolResult(await this.post("tools/call", { name, arguments: safeArgs }, true, signal));
	}

	async close(): Promise<void> {}
}

class McpStdioConnection implements McpConnection {
	private readonly config: Extract<McpServerConfig, { transport: "stdio" }>;
	private readonly pending = new Map<number, PendingStdioRequest>();
	private nextId = 1;
	private process?: ChildProcessWithoutNullStreams;
	private lines?: ReadlineInterface;
	private protocolVersion: string;

	constructor(config: Extract<McpServerConfig, { transport: "stdio" }>) {
		this.config = config;
		this.protocolVersion = config.protocolVersion;
	}

	private ensureProcess(): ChildProcessWithoutNullStreams {
		if (this.process && !this.process.killed) return this.process;
		const child = spawn(this.config.command, this.config.args, {
			cwd: this.config.cwd,
			env: { ...process.env, ...this.config.env },
			stdio: "pipe",
		});
		this.process = child;
		this.lines = createInterface({ input: child.stdout });
		this.lines.on("line", (line) => this.handleLine(line));
		child.once("error", (error) => this.handleProcessFailure(child, error));
		child.once("exit", (code, signal) => {
			this.handleProcessFailure(
				child,
				new Error(`MCP stdio process exited: code=${code ?? "none"} signal=${signal ?? "none"}`),
			);
		});
		return child;
	}

	private handleProcessFailure(child: ChildProcessWithoutNullStreams, error: Error): void {
		if (this.process !== child) return;
		this.lines?.close();
		this.lines = undefined;
		this.process = undefined;
		this.rejectAll(error);
	}

	private stopProcess(error: Error): void {
		const child = this.process;
		this.lines?.close();
		this.lines = undefined;
		this.process = undefined;
		this.rejectAll(error);
		if (child) terminateChild(child);
	}

	private handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		const response = toJsonRpcResponse(parsed);
		if (!response || typeof response.id !== "number") return;
		const pending = this.pending.get(response.id);
		if (!pending) return;
		this.pending.delete(response.id);
		pending.cleanup();
		try {
			pending.resolve(rpcResult(response));
		} catch (error) {
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.cleanup();
			pending.reject(error);
		}
		this.pending.clear();
	}

	private request(method: string, params: JsonValue, signal?: AbortSignal): Promise<JsonValue | undefined> {
		if (signal?.aborted) return Promise.reject(new Error("MCP stdio request aborted"));
		const child = this.ensureProcess();
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				if (!this.pending.has(id)) return;
				this.stopProcess(new Error("MCP stdio request aborted"));
			};
			const timer = setTimeout(() => {
				if (!this.pending.has(id)) return;
				this.stopProcess(new Error(`MCP stdio request timed out after ${this.config.timeoutMs}ms`));
			}, this.config.timeoutMs);
			timer.unref();
			this.pending.set(id, {
				resolve,
				reject,
				cleanup: () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
				},
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
					if (error && this.pending.has(id)) this.stopProcess(error);
				});
			} catch (error) {
				this.stopProcess(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private notify(method: string, params: JsonValue): void {
		this.ensureProcess().stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	async initialize(signal?: AbortSignal): Promise<void> {
		const result = await this.request(
			"initialize",
			{
				protocolVersion: this.protocolVersion,
				capabilities: {},
				clientInfo: { name: "secheur-agent", version: "0.1.0" },
			},
			signal,
		);
		if (isRecord(result) && typeof result.protocolVersion === "string") {
			this.protocolVersion = result.protocolVersion;
		}
		this.notify("notifications/initialized", {});
	}

	async listTools(signal?: AbortSignal): Promise<McpRemoteTool[]> {
		return parseToolList(await this.request("tools/list", {}, signal));
	}

	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
		const safeArgs = asJsonValue(args);
		if (!safeArgs || !isRecord(safeArgs)) throw new Error("MCP tool arguments must be JSON-serializable");
		return parseToolResult(await this.request("tools/call", { name, arguments: safeArgs }, signal));
	}

	async close(): Promise<void> {
		this.stopProcess(new Error("MCP stdio connection closed"));
	}
}

function safeNamePart(value: string, fallback: string): string {
	let safe = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
	while (safe.includes("__")) safe = safe.replaceAll("__", "_");
	return safe || fallback;
}

export function makeMcpToolName(serverName: string, toolName: string): string {
	const base = `mcp__${safeNamePart(serverName, "server")}__${safeNamePart(toolName, "tool")}`;
	if (base.length <= MCP_TOOL_NAME_MAX_LENGTH) return base;
	const suffix = `_${createHash("sha1").update(`${serverName}\0${toolName}`).digest("hex").slice(0, 10)}`;
	return `${base.slice(0, MCP_TOOL_NAME_MAX_LENGTH - suffix.length).replace(/_+$/g, "")}${suffix}`;
}

function connectionFor(config: McpServerConfig): McpConnection {
	return config.transport === "http" ? new McpHttpConnection(config) : new McpStdioConnection(config);
}

export class McpManager {
	private readonly configs: Record<string, McpServerConfig>;
	private readonly connections = new Map<string, McpConnection>();
	private readonly tools = new Map<string, McpExposedTool>();
	private currentDiagnostics: Record<string, McpDiagnostic> = {};
	private refreshAbort?: AbortController;

	constructor(configs: Record<string, McpServerConfig>) {
		this.configs = configs;
	}

	get diagnostics(): Record<string, McpDiagnostic> {
		return structuredClone(this.currentDiagnostics);
	}

	get exposedTools(): McpExposedTool[] {
		return [...this.tools.values()];
	}

	get legacyToolSchemas(): LegacyMcpToolSchema[] {
		return this.exposedTools.map((tool) => ({
			type: "function",
			function: {
				name: tool.exposedName,
				description: tool.description || `MCP tool ${tool.name} from ${tool.serverName}`,
				parameters: tool.inputSchema,
			},
		}));
	}

	async refresh(signal?: AbortSignal): Promise<McpExposedTool[]> {
		this.refreshAbort?.abort(new Error("MCP refresh superseded"));
		const controller = new AbortController();
		this.refreshAbort = controller;
		const onAbort = () => controller.abort(signal?.reason ?? new Error("MCP refresh aborted"));
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await this.closeConnections();
			controller.signal.throwIfAborted();
			const diagnostics: Record<string, McpDiagnostic> = {};
			for (const [serverName, config] of Object.entries(this.configs)) {
				controller.signal.throwIfAborted();
				const connection = connectionFor(config);
				try {
					await connection.initialize(controller.signal);
					const remoteTools = await connection.listTools(controller.signal);
					controller.signal.throwIfAborted();
					this.connections.set(serverName, connection);
					for (const tool of remoteTools) {
						const exposedName = makeMcpToolName(serverName, tool.name);
						this.tools.set(exposedName, { ...tool, exposedName, serverName });
					}
					diagnostics[serverName] = {
						status: "connected",
						transport: config.transport,
						endpoint: config.transport === "http" ? config.url : config.command,
						tools: remoteTools.map((tool) => tool.name),
					};
				} catch (error) {
					await connection.close();
					controller.signal.throwIfAborted();
					diagnostics[serverName] = {
						status: "error",
						transport: config.transport,
						endpoint: config.transport === "http" ? config.url : config.command,
						tools: [],
						message: error instanceof Error ? error.message : String(error),
					};
				}
			}
			this.currentDiagnostics = diagnostics;
			return this.exposedTools;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (this.refreshAbort === controller) this.refreshAbort = undefined;
		}
	}

	async callTool(exposedName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
		const tool = this.tools.get(exposedName);
		if (!tool) throw new Error(`Unknown MCP tool: ${exposedName}`);
		const connection = this.connections.get(tool.serverName);
		if (!connection) throw new Error(`MCP server is not connected: ${tool.serverName}`);
		try {
			return await connection.callTool(tool.name, args, signal);
		} catch (error) {
			await connection.close();
			this.connections.delete(tool.serverName);
			for (const [name, exposed] of this.tools) {
				if (exposed.serverName === tool.serverName) this.tools.delete(name);
			}
			const previous = this.currentDiagnostics[tool.serverName];
			const config = this.configs[tool.serverName];
			this.currentDiagnostics[tool.serverName] = {
				status: "error",
				transport: previous?.transport ?? config?.transport ?? "http",
				endpoint: previous?.endpoint ?? (config?.transport === "http" ? config.url : config?.command) ?? "unknown",
				tools: [],
				message: error instanceof Error ? error.message : String(error),
			};
			throw error;
		}
	}

	async close(): Promise<void> {
		this.refreshAbort?.abort(new Error("MCP manager closed"));
		this.refreshAbort = undefined;
		await this.closeConnections();
	}

	private async closeConnections(): Promise<void> {
		await Promise.allSettled([...this.connections.values()].map((connection) => connection.close()));
		this.connections.clear();
		this.tools.clear();
	}
}

export function registerMcpExtension(pi: ExtensionAPI, manager: McpManager): void {
	const registered = new Set<string>();
	let reconnectAttempt = 0;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let refreshInFlight: Promise<McpExposedTool[]> | undefined;
	let stopped = false;
	let scheduleReconnect = (): void => {};

	const registerTools = (tools: McpExposedTool[]) => {
		for (const tool of tools) {
			if (registered.has(tool.exposedName)) continue;
			registered.add(tool.exposedName);
			pi.registerTool({
				name: tool.exposedName,
				label: `${tool.serverName}: ${tool.name}`,
				description: tool.description || `MCP tool ${tool.name} from ${tool.serverName}`,
				parameters: tool.inputSchema,
				executionMode: "sequential",
				async execute(_toolCallId, params, signal) {
					const input = isRecord(params) ? params : {};
					try {
						const result = await manager.callTool(tool.exposedName, input, signal);
						return {
							content: result.content,
							details: {
								serverName: tool.serverName,
								toolName: tool.name,
								...(result.structuredContent === undefined
									? {}
									: { structuredContent: result.structuredContent }),
							},
							isError: result.isError,
						};
					} catch (error) {
						scheduleReconnect();
						throw error;
					}
				},
			});
		}
	};

	const syncActiveTools = (tools: McpExposedTool[]) => {
		const available = new Set(tools.map((tool) => tool.exposedName));
		const current = pi.getActiveTools();
		const next = current.filter((name) => !registered.has(name) || available.has(name));
		for (const name of available) {
			if (!next.includes(name)) next.push(name);
		}
		if (next.length !== current.length || next.some((name, index) => name !== current[index])) {
			pi.setActiveTools(next);
		}
	};

	const refresh = (signal?: AbortSignal): Promise<McpExposedTool[]> => {
		if (refreshInFlight) return refreshInFlight;
		const operation = manager.refresh(signal).then((tools) => {
			registerTools(tools);
			syncActiveTools(tools);
			return tools;
		});
		refreshInFlight = operation;
		const clearRefresh = () => {
			if (refreshInFlight === operation) refreshInFlight = undefined;
		};
		void operation.then(clearRefresh, clearRefresh);
		return operation;
	};

	const refreshAndSchedule = async (): Promise<McpExposedTool[]> => {
		const tools = await refresh();
		const failures = Object.values(manager.diagnostics).filter((diagnostic) => diagnostic.status === "error");
		if (failures.length === 0) {
			reconnectAttempt = 0;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			reconnectTimer = undefined;
		} else {
			scheduleReconnect();
		}
		return tools;
	};

	scheduleReconnect = () => {
		if (stopped || reconnectTimer) return;
		const delayMs = Math.min(60_000, 2_000 * 2 ** Math.min(reconnectAttempt, 5));
		reconnectAttempt += 1;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			void refreshAndSchedule().catch(() => scheduleReconnect());
		}, delayMs);
		reconnectTimer.unref();
	};

	pi.registerTool({
		name: "mcp_refresh",
		label: "Refresh MCP",
		description: "Reconnect configured MCP servers and refresh their exposed tools.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute(_toolCallId, _params, signal) {
			const tools = await refresh(signal);
			const structuredContent = {
				tools: tools.map((tool) => tool.exposedName),
				diagnostics: manager.diagnostics,
			};
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(structuredContent),
					},
				],
				details: { structuredContent },
			};
		},
	});

	pi.registerCommand("mcp-refresh", {
		description: "Reconnect configured MCP servers and refresh tools",
		handler: async (_args, ctx) => {
			const tools = await refresh();
			ctx.ui.notify(`MCP refresh complete: ${tools.length} tools`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		void refreshAndSchedule().then(
			(tools) => {
				if (stopped) return;
				const failures = Object.values(manager.diagnostics).filter((diagnostic) => diagnostic.status === "error");
				if (failures.length > 0) {
					ctx.ui.notify(`MCP unavailable: ${failures.length} server(s); reconnect scheduled`, "warning");
				} else if (tools.length > 0) {
					ctx.ui.notify(`MCP tools loaded: ${tools.length}`, "info");
				}
			},
			() => scheduleReconnect(),
		);
	});

	pi.on("session_shutdown", async () => {
		stopped = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = undefined;
		await manager.close();
	});
}
