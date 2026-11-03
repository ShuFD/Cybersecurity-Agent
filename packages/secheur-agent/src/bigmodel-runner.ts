import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_BIGMODEL_MODEL, DEFAULT_BIGMODEL_RESPONSES_ENDPOINT } from "./bigmodel-config.ts";
import { sha256Text } from "./competition-protocol.ts";

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export type BigModelActionName = "read_file" | "run_gdb" | "run_exploit" | "connect_local" | "wait_shell";

export interface ShellProof {
	nonce: string;
	command: string;
	output: string;
	verified: boolean;
	createdAt: number;
}

export interface BigModelRunnerOptions {
	workdir: string;
	endpoint?: string;
	model?: string;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	maxTurns?: number;
	requestTimeoutMs?: number;
	auditPath?: string;
	onShellProof?: (nonce: string, workdir: string) => Promise<ShellProof | undefined>;
}

export interface BigModelRunnerResult {
	text: string;
	model: string;
	requestHashes: string[];
	toolCalls: Array<{ name: BigModelActionName; arguments: Record<string, unknown>; output: unknown }>;
	shellProof?: ShellProof;
}

interface ResponseItem {
	type?: unknown;
	name?: unknown;
	arguments?: unknown;
	call_id?: unknown;
	output_text?: unknown;
	text?: unknown;
	content?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function json(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "null";
	}
}

function redact(value: unknown, depth = 0): unknown {
	if (depth > 8) return "[TRUNCATED]";
	if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, child]) => {
			if (/(?:api[_-]?key|authorization|access[_-]?key|password|secret|cookie|token)/iu.test(key))
				return [key, "[REDACTED]"];
			return [key, redact(child, depth + 1)];
		}),
	);
}

function ensureInside(root: string, candidate: string): string {
	const rootPath = resolve(root);
	const resolvedRoot = realpathSync(rootPath);
	const resolvedCandidate = resolve(rootPath, candidate);
	const lexicalRelative = relative(rootPath, resolvedCandidate);
	if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
		throw new Error("BigModel action path escapes the challenge workdir");
	}
	const resolved = realpathSync(resolvedCandidate);
	const relativePath = relative(resolvedRoot, resolved);
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error("BigModel action path escapes the challenge workdir");
	}
	return resolved;
}

function ensureTargetWorkdir(workdir: string): string {
	const resolved = resolve(workdir);
	if (basename(resolved) !== "10756") throw new Error("BigModel runner is restricted to the 10756 workdir");
	if (!existsSync(resolved) || !statSync(resolved).isDirectory())
		throw new Error("BigModel 10756 workdir does not exist");
	return resolved;
}

function actionName(value: unknown): value is BigModelActionName {
	return (
		value === "read_file" ||
		value === "run_gdb" ||
		value === "run_exploit" ||
		value === "connect_local" ||
		value === "wait_shell"
	);
}

function actionArgs(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function responseItems(value: unknown): ResponseItem[] {
	if (!isRecord(value) || !Array.isArray(value.output)) return [];
	return value.output.filter(isRecord) as ResponseItem[];
}

function responseText(value: unknown): string {
	if (!isRecord(value)) return "";
	if (typeof value.output_text === "string") return value.output_text;
	const items = responseItems(value);
	return items
		.flatMap((item) => {
			if (typeof item.text === "string") return [item.text];
			if (typeof item.output_text === "string") return [item.output_text];
			if (Array.isArray(item.content))
				return item.content.flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []));
			return [];
		})
		.join("\n");
}

function toolDefinitions(): unknown[] {
	const definitions: Array<{
		name: BigModelActionName;
		description: string;
		properties: Record<string, unknown>;
		required: string[];
	}> = [
		{
			name: "read_file",
			description: "Read a bounded text or binary file inside the assigned 10756 workdir.",
			properties: { path: { type: "string" }, max_bytes: { type: "integer" } },
			required: ["path"],
		},
		{
			name: "run_gdb",
			description: "Run batch GDB analysis against an ELF inside the assigned 10756 workdir.",
			properties: { binary: { type: "string" }, commands: { type: "array", items: { type: "string" } } },
			required: ["binary", "commands"],
		},
		{
			name: "run_exploit",
			description: "Run an exploit executable or script inside the assigned 10756 workdir.",
			properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } } },
			required: ["command"],
		},
		{
			name: "connect_local",
			description: "Connect to a loopback TCP service only.",
			properties: { port: { type: "integer" }, input: { type: "string" }, timeout_ms: { type: "integer" } },
			required: ["port"],
		},
		{
			name: "wait_shell",
			description: "Wait for the nonce-bearing local shell proof callback.",
			properties: { nonce: { type: "string" }, command: { type: "string" } },
			required: ["nonce", "command"],
		},
	];
	return definitions.map((definition) => ({
		type: "function",
		name: definition.name,
		description: definition.description,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: definition.properties,
			required: definition.required,
		},
	}));
}

export class BigModelRunner {
	readonly workdir: string;
	readonly endpoint: string;
	readonly model: string;
	private readonly apiKey: string;
	private readonly fetchImpl: typeof fetch;
	private readonly maxTurns: number;
	private readonly requestTimeoutMs: number;
	private readonly auditPath: string;
	private readonly onShellProof?: BigModelRunnerOptions["onShellProof"];
	private shellProof?: ShellProof;

	constructor(options: BigModelRunnerOptions) {
		this.workdir = ensureTargetWorkdir(options.workdir);
		const env = options.env ?? process.env;
		this.apiKey = env.BIGMODEL_API_KEY?.trim() ?? "";
		if (!this.apiKey) throw new Error("BIGMODEL_API_KEY is required and must be supplied through the environment");
		this.endpoint = options.endpoint ?? env.BIGMODEL_RESPONSES_ENDPOINT ?? DEFAULT_BIGMODEL_RESPONSES_ENDPOINT;
		this.model = options.model ?? env.BIGMODEL_MODEL ?? DEFAULT_BIGMODEL_MODEL;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.maxTurns = Math.max(1, Math.trunc(options.maxTurns ?? 12));
		this.requestTimeoutMs = Math.max(1_000, Math.trunc(options.requestTimeoutMs ?? 120_000));
		this.auditPath = options.auditPath ?? `${this.workdir}/bigmodel-runner.audit.jsonl`;
		this.onShellProof = options.onShellProof;
		mkdirSync(dirname(this.auditPath), { recursive: true });
	}

	get nonce(): string {
		return randomBytes(12).toString("hex");
	}

	async probe(
		signal?: AbortSignal,
	): Promise<{ endpoint: string; model: string; compatible: boolean; responseHash?: string }> {
		const result = await this.call([{ role: "user", content: "Return only the word ready." }], signal, 8);
		return {
			endpoint: this.endpoint,
			model: this.model,
			compatible: Boolean(result.response),
			responseHash: result.responseHash,
		};
	}

	async run(prompt: string, signal?: AbortSignal): Promise<BigModelRunnerResult> {
		const requestHashes: string[] = [];
		const toolCalls: BigModelRunnerResult["toolCalls"] = [];
		const input: unknown[] = [{ role: "user", content: prompt }];
		let finalText = "";
		for (let turn = 0; turn < this.maxTurns; turn += 1) {
			const result = await this.call(input, signal);
			requestHashes.push(result.requestHash);
			const items = responseItems(result.response);
			finalText = responseText(result.response) || finalText;
			const calls = items.filter((item) => item.type === "function_call");
			if (calls.length === 0) break;
			for (const item of calls) {
				const name = stringValue(item.name);
				if (!actionName(name)) throw new Error(`BigModel requested a disallowed action: ${name}`);
				let parsedArguments: Record<string, unknown> = {};
				try {
					parsedArguments = actionArgs(
						typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments,
					);
				} catch {
					parsedArguments = {};
				}
				const output = await this.executeAction(name, parsedArguments, signal);
				toolCalls.push({ name, arguments: parsedArguments, output });
				input.push(item);
				input.push({
					type: "function_call_output",
					call_id: stringValue(item.call_id) || randomBytes(8).toString("hex"),
					output: json(output),
				});
			}
		}
		return {
			text: finalText,
			model: this.model,
			requestHashes,
			toolCalls,
			...(this.shellProof ? { shellProof: this.shellProof } : {}),
		};
	}

	private async call(
		input: unknown[],
		signal?: AbortSignal,
		maxOutputTokens = 8_192,
	): Promise<{ response: Record<string, unknown>; requestHash: string; responseHash: string }> {
		const body = {
			model: this.model,
			input,
			tools: toolDefinitions(),
			max_output_tokens: maxOutputTokens,
			metadata: { challenge_id: "10756" },
		};
		const requestHash = createHash("sha256").update(json(body), "utf8").digest("hex");
		this.appendAudit({ type: "request", requestHash, body });
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
		const onAbort = (): void => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const response = await this.fetchImpl(this.endpoint, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: json(body),
				signal: controller.signal,
			});
			const responseBody = await response.text();
			let parsed: unknown = {};
			try {
				parsed = responseBody ? JSON.parse(responseBody) : {};
			} catch {
				throw new Error("BigModel returned invalid JSON");
			}
			if (!response.ok) throw new Error(`BigModel Responses request failed: HTTP ${response.status}`);
			const responseRecord = isRecord(parsed) ? parsed : {};
			const responseHash = sha256Text(responseBody);
			this.appendAudit({ type: "response", requestHash, responseHash, response: responseRecord });
			return { response: responseRecord, requestHash, responseHash };
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	private async executeAction(
		name: BigModelActionName,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (name === "read_file") {
			const path = ensureInside(this.workdir, stringValue(args.path));
			const maxBytes = Math.min(MAX_FILE_BYTES, Math.max(1, Number(args.max_bytes ?? MAX_FILE_BYTES)));
			const bytes = readFileSync(path).subarray(0, maxBytes);
			return {
				path: relative(this.workdir, path),
				truncated: bytes.byteLength < statSync(path).size,
				content_base64: bytes.toString("base64"),
			};
		}
		if (name === "run_gdb") {
			const binary = ensureInside(this.workdir, stringValue(args.binary));
			const commands = Array.isArray(args.commands)
				? args.commands.filter((value): value is string => typeof value === "string")
				: [];
			if (commands.some((command) => /\b(?:shell|python|quit|source)\b/iu.test(command)))
				throw new Error("Unsafe GDB command rejected");
			return this.runProgram(
				"gdb",
				["--batch", "--nx", "--nh", binary, ...commands.flatMap((command) => ["-ex", command])],
				signal,
			);
		}
		if (name === "run_exploit") {
			const command = stringValue(args.command);
			const executable = ensureInside(this.workdir, command);
			const commandArgs = Array.isArray(args.args)
				? args.args.filter((value): value is string => typeof value === "string")
				: [];
			return this.runProgram(executable, commandArgs, signal);
		}
		if (name === "connect_local")
			return this.connectLocal(Number(args.port), stringValue(args.input), Number(args.timeout_ms ?? 5_000), signal);
		const nonce = stringValue(args.nonce);
		if (!nonce || nonce.length < 8) throw new Error("A nonce-bearing shell proof is required");
		if (!this.onShellProof) return { verified: false, reason: "shell proof callback is not configured", nonce };
		const proof = await this.onShellProof(nonce, this.workdir);
		if (proof) {
			this.shellProof = proof;
			this.appendAudit({ type: "shell_proof", proof });
		}
		return proof ?? { verified: false, nonce };
	}

	private async runProgram(command: string, args: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
		const childEnv = { ...process.env };
		delete childEnv.BIGMODEL_API_KEY;
		const result = await execFileAsync(command, args, {
			cwd: this.workdir,
			env: childEnv,
			timeout: 120_000,
			maxBuffer: 512 * 1024,
			signal,
		});
		return { stdout: result.stdout.slice(-64 * 1024), stderr: result.stderr.slice(-64 * 1024) };
	}

	private connectLocal(
		port: number,
		input: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid local TCP port");
		return new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
			const socket = createConnection({ host: "127.0.0.1", port });
			let output = Buffer.alloc(0);
			const timer = setTimeout(() => {
				socket.destroy();
				rejectPromise(new Error("Local TCP action timed out"));
			}, timeoutMs);
			const abort = (): void => {
				clearTimeout(timer);
				socket.destroy();
				rejectPromise(new Error("Operation aborted"));
			};
			signal?.addEventListener("abort", abort, { once: true });
			const finish = (): void => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
			};
			socket.on("data", (chunk: Buffer) => {
				output = Buffer.concat([output, chunk]).subarray(-64 * 1024);
			});
			socket.once("connect", () => {
				if (input) socket.write(input);
			});
			socket.once("error", (error) => {
				finish();
				rejectPromise(error);
			});
			socket.once("close", () => {
				finish();
				resolvePromise({ host: "127.0.0.1", port, output: output.toString("base64") });
			});
		});
	}

	private appendAudit(value: Record<string, unknown>): void {
		const safe = redact(value);
		const encoded = json(safe).split(this.apiKey).join("[REDACTED]");
		writeFileSync(this.auditPath, `${encoded}\n`, { flag: "a", mode: 0o600 });
	}
}
