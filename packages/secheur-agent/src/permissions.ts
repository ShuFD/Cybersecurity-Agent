import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "./config.ts";

export interface PermissionRequest {
	id: string;
	toolName: string;
	input: Record<string, unknown>;
	message: string;
	createdAt: number;
}

export type PermissionAction = "allow" | "deny" | "confirm";

export interface PermissionEvaluation {
	action: PermissionAction;
	reason: string;
}

interface PendingPermission {
	request: PermissionRequest;
	resolve: (resolution: PermissionResolution) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
	fallback?: () => Promise<PermissionResolution>;
	fallbackStarted: boolean;
}

interface PermissionResolution {
	allowed: boolean;
	answer?: string;
}

const READ_ONLY_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"file_read",
	"grep_search",
	"list_files",
	"memory_search",
	"attack_memory_search",
	"task_output",
	"web_scan",
	"web_fetch",
	"osv_query",
	"tool_search",
	"mcp_refresh",
	"plan_expand",
	"plan_revise",
	"plan_status",
]);

const EDIT_TOOLS = new Set(["edit", "write", "file_patch", "file_write", "update_working_checkpoint"]);
const ALWAYS_ALLOWED_TOOLS = new Set(["ask_user", "exit_plan_mode", "verify_flag", "check_flag", "no_tool"]);
const SHELL_TOOLS = new Set(["bash", "code_run"]);
const EXTERNAL_SIDE_EFFECT_TOOLS = new Set([
	"web_execute_js",
	"web_verb_call",
	"ctf_verb_call",
	"sub_agent",
	"start_long_term_update",
]);

const DANGEROUS_COMMAND_PATTERNS = [
	/(^|[;&|]\s*)rm\s+[^\n]*(?:-r|-f|--recursive|--force)/i,
	/\bsudo\b/i,
	/\b(?:chmod|chown)\b[^\n]*(?:777|-R|--recursive)/i,
	/\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\s+[^\n]*--force)\b/i,
	/\bdocker\s+(?:rm|rmi|system\s+prune|volume\s+rm)\b/i,
	/\b(?:mkfs|fdisk|parted|shutdown|reboot|halt|poweroff)\b/i,
	/(?:^|\s)(?:curl|wget)\b[^\n]*(?:--upload-file|-T\s|--data-binary\s+@)/i,
	/>\s*\/(?:etc|usr|bin|sbin|boot|System)(?:\/|\s|$)/i,
];

const PLAN_SAFE_COMMAND_PATTERNS = ["pwd", "ls", "grep", "head", "tail", "wc", "file", "stat", "cat", "bat"];

const FIND_SIDE_EFFECT_ARGUMENTS = new Set([
	"-delete",
	"-exec",
	"-execdir",
	"-fls",
	"-fprint",
	"-fprint0",
	"-fprintf",
	"-ok",
	"-okdir",
]);

function shellWords(command: string): string[] | undefined {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (const char of command) {
		if (quote) {
			if (char === quote) {
				quote = undefined;
				continue;
			}
			if (quote === '"' && (char === "$" || char === "`" || char === "\\")) return undefined;
			current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/u.test(char)) {
			if (char === "\n" || char === "\r") return undefined;
			if (current) {
				words.push(current);
				current = "";
			}
			continue;
		}
		if (/[;&|<>`$()\\#\0]/u.test(char)) return undefined;
		current += char;
	}
	if (quote) return undefined;
	if (current) words.push(current);
	return words;
}

function isSafeSed(words: string[]): boolean {
	const scripts: string[] = [];
	let expectScript = false;
	let foundOperand = false;
	for (const word of words.slice(1)) {
		if (expectScript) {
			scripts.push(word);
			expectScript = false;
			continue;
		}
		if (word === "-e" || word === "--expression") {
			expectScript = true;
			continue;
		}
		if (word.startsWith("--expression=")) {
			scripts.push(word.slice("--expression=".length));
			continue;
		}
		if (["-n", "--quiet", "--silent", "-E", "-r", "--regexp-extended"].includes(word)) continue;
		if (word.startsWith("-")) return false;
		if (scripts.length === 0 && !foundOperand) scripts.push(word);
		else foundOperand = true;
	}
	return (
		!expectScript &&
		scripts.length > 0 &&
		scripts.every((script) => /^\s*(?:(?:\d+|\$)(?:\s*,\s*(?:\d+|\$))?)?\s*[p=l]\s*$/u.test(script))
	);
}

function isSafeAwk(words: string[]): boolean {
	let program: string | undefined;
	for (let index = 1; index < words.length; index += 1) {
		const word = words[index];
		if (word === "-f" || word === "--file") return false;
		if (word === "-v" || word === "--assign") {
			index += 1;
			continue;
		}
		if (word.startsWith("-F") || word.startsWith("-v") || word.startsWith("--assign=")) continue;
		if (word.startsWith("-")) return false;
		program = word;
		break;
	}
	return Boolean(program && !/\bsystem\s*\(|[|<>@]/iu.test(program));
}

function isSafeGit(words: string[]): boolean {
	const subcommand = words[1]?.toLowerCase();
	if (!subcommand || !["status", "diff", "log", "show", "branch"].includes(subcommand)) return false;
	const args = words.slice(2);
	if (
		args.some(
			(argument) => /^--(?:output|ext-diff|textconv|exec)(?:=|$)/iu.test(argument) || argument === "--no-pager",
		)
	) {
		return false;
	}
	if (subcommand !== "branch") return true;
	return args.every(
		(argument) =>
			/^-[arv]+$/u.test(argument) ||
			/^--(?:all|remotes|verbose|list|show-current|ignore-case|omit-empty|no-color|no-column)$/u.test(argument) ||
			/^--(?:abbrev|color|column|contains|no-contains|merged|no-merged|points-at|sort|format|list)=/u.test(argument),
	);
}

function canonicalPermissionValue(value: unknown, ancestors = new Set<object>()): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
	if (typeof value !== "object") return JSON.stringify(String(value));
	if (ancestors.has(value)) return JSON.stringify("[Circular]");
	ancestors.add(value);
	let result: string;
	if (Array.isArray(value)) {
		result = `[${value.map((item) => canonicalPermissionValue(item, ancestors)).join(",")}]`;
	} else {
		result = `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonicalPermissionValue((value as Record<string, unknown>)[key], ancestors)}`,
			)
			.join(",")}}`;
	}
	ancestors.delete(value);
	return result;
}

function permissionSignature(toolName: string, input: Record<string, unknown>): string {
	return `${JSON.stringify(toolName)}:${canonicalPermissionValue(input)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellCommand(input: Record<string, unknown>): string {
	for (const key of ["command", "script", "code"]) {
		if (typeof input[key] === "string") return input[key];
	}
	return "";
}

export function isDangerousCommand(command: string): boolean {
	return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

export function isPlanSafeCommand(command: string): boolean {
	if (!command.trim() || isDangerousCommand(command)) return false;
	const words = shellWords(command);
	if (!words || words.length === 0) return false;
	const executable = words[0].toLowerCase();
	if (PLAN_SAFE_COMMAND_PATTERNS.includes(executable)) return true;
	if (executable === "find") {
		return !words.slice(1).some((word) => FIND_SIDE_EFFECT_ARGUMENTS.has(word.toLowerCase()));
	}
	if (executable === "rg") return !words.slice(1).some((word) => /^--pre(?:=|$)/iu.test(word));
	if (executable === "sed") return isSafeSed(words);
	if (executable === "awk") return isSafeAwk(words);
	if (executable === "git") return isSafeGit(words);
	if (executable === "npm") return ["list", "ls", "view"].includes(words[1]?.toLowerCase() ?? "");
	return ["node", "python", "python3"].includes(executable) && words.length === 2 && words[1] === "--version";
}

export function evaluateToolPermission(
	mode: PermissionMode,
	toolName: string,
	input: Record<string, unknown>,
): PermissionEvaluation {
	if (mode === "bypassPermissions" || ALWAYS_ALLOWED_TOOLS.has(toolName)) {
		return { action: "allow", reason: "Permission mode allows this tool" };
	}

	if (mode === "plan") {
		if (READ_ONLY_TOOLS.has(toolName)) return { action: "allow", reason: "Read-only tool allowed in plan mode" };
		if (SHELL_TOOLS.has(toolName) && isPlanSafeCommand(shellCommand(input))) {
			return { action: "allow", reason: "Read-only command allowed in plan mode" };
		}
		return { action: "deny", reason: `Plan mode blocks ${toolName}` };
	}

	if (READ_ONLY_TOOLS.has(toolName)) return { action: "allow", reason: "Read-only tool" };

	if (SHELL_TOOLS.has(toolName)) {
		if (!isDangerousCommand(shellCommand(input))) return { action: "allow", reason: "Command passed risk checks" };
		if (mode === "dontAsk") return { action: "deny", reason: "Dangerous command denied in dontAsk mode" };
		return { action: "confirm", reason: "Command matched a dangerous-operation rule" };
	}

	if (EDIT_TOOLS.has(toolName)) {
		if (mode === "default") return { action: "confirm", reason: "File mutation requires confirmation" };
		return { action: "allow", reason: "File mutations are allowed in this mode" };
	}

	if (toolName.startsWith("mcp__") || EXTERNAL_SIDE_EFFECT_TOOLS.has(toolName)) {
		if (mode === "dontAsk") return { action: "deny", reason: "Unclassified side effect denied in dontAsk mode" };
		return { action: "confirm", reason: "External side effect requires confirmation" };
	}

	return { action: "allow", reason: "Tool has no restricted capability" };
}

export class PermissionBroker {
	private readonly pending = new Map<string, PendingPermission>();
	private readonly listeners = new Set<(request: PermissionRequest) => void>();
	private remoteUiAvailable = false;

	list(): PermissionRequest[] {
		return [...this.pending.values()].map(({ request }) => request);
	}

	subscribe(listener: (request: PermissionRequest) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	setRemoteUiAvailable(available: boolean): void {
		this.remoteUiAvailable = available;
		if (available) return;
		for (const pending of this.pending.values()) this.startFallback(pending);
	}

	private enqueue(
		toolName: string,
		input: Record<string, unknown>,
		message: string,
		signal?: AbortSignal,
		fallback?: () => Promise<PermissionResolution>,
	): { request: PermissionRequest; promise: Promise<PermissionResolution> } {
		const request: PermissionRequest = {
			id: randomUUID(),
			toolName,
			input,
			message,
			createdAt: Date.now(),
		};
		const promise = new Promise<PermissionResolution>((resolve, reject) => {
			const onAbort = () => {
				this.pending.delete(request.id);
				signal?.removeEventListener("abort", onAbort);
				reject(new Error("Permission request aborted"));
			};
			const pending: PendingPermission = {
				request,
				resolve,
				reject,
				cleanup: () => signal?.removeEventListener("abort", onAbort),
				fallback,
				fallbackStarted: false,
			};
			this.pending.set(request.id, pending);
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			for (const listener of this.listeners) listener(request);
			if (!this.remoteUiAvailable) this.startFallback(pending);
		});
		return { request, promise };
	}

	private startFallback(pending: PendingPermission): void {
		if (!pending.fallback || pending.fallbackStarted || !this.pending.has(pending.request.id)) return;
		pending.fallbackStarted = true;
		void pending
			.fallback()
			.then((resolution) => this.resolve(pending.request.id, resolution.allowed, resolution.answer))
			.catch(() => this.resolve(pending.request.id, false));
	}

	async request(
		toolName: string,
		input: Record<string, unknown>,
		message: string,
		signal?: AbortSignal,
	): Promise<boolean> {
		return (await this.enqueue(toolName, input, message, signal).promise).allowed;
	}

	async requestWithFallback(
		toolName: string,
		input: Record<string, unknown>,
		message: string,
		fallback: () => Promise<boolean>,
		signal?: AbortSignal,
	): Promise<boolean> {
		return (await this.enqueue(toolName, input, message, signal, async () => ({ allowed: await fallback() })).promise)
			.allowed;
	}

	async requestAnswer(
		toolName: string,
		input: Record<string, unknown>,
		message: string,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		const resolution = await this.enqueue(toolName, input, message, signal).promise;
		return resolution.allowed ? resolution.answer : undefined;
	}

	async requestAnswerWithFallback(
		toolName: string,
		input: Record<string, unknown>,
		message: string,
		fallback: () => Promise<string | undefined>,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		const resolution = await this.enqueue(toolName, input, message, signal, async () => {
			const answer = await fallback();
			return { allowed: answer !== undefined, answer };
		}).promise;
		return resolution.allowed ? resolution.answer : undefined;
	}

	resolve(id: string, allowed: boolean, answer?: string): boolean {
		const pending = this.pending.get(id);
		if (!pending) return false;
		this.pending.delete(id);
		pending.cleanup();
		pending.resolve({ allowed, answer });
		return true;
	}

	cancelAll(reason = "Permission broker closed"): void {
		const error = new Error(reason);
		for (const pending of this.pending.values()) {
			pending.cleanup();
			pending.reject(error);
		}
		this.pending.clear();
	}
}

export class PermissionController {
	readonly broker: PermissionBroker;
	private currentMode: PermissionMode;
	private readonly sessionGrants = new Set<string>();

	constructor(mode: PermissionMode, broker = new PermissionBroker()) {
		this.currentMode = mode;
		this.broker = broker;
	}

	get mode(): PermissionMode {
		return this.currentMode;
	}

	setMode(mode: PermissionMode): void {
		this.currentMode = mode;
	}

	evaluate(toolName: string, input: Record<string, unknown>): PermissionEvaluation {
		const decision = evaluateToolPermission(this.currentMode, toolName, input);
		if (decision.action !== "confirm" || !this.sessionGrants.has(permissionSignature(toolName, input))) {
			return decision;
		}
		return { action: "allow", reason: "Tool arguments were allowed for this session" };
	}

	allowForSession(toolName: string, input: Record<string, unknown>): string {
		const signature = permissionSignature(toolName, input);
		this.sessionGrants.add(signature);
		return signature;
	}

	restoreSessionGrants(signatures: Iterable<string>): void {
		for (const signature of signatures) {
			if (signature) this.sessionGrants.add(signature);
		}
	}

	get sessionGrantSignatures(): string[] {
		return [...this.sessionGrants];
	}
}

async function confirmWithAvailableUi(
	controller: PermissionController,
	ctx: ExtensionContext,
	toolName: string,
	input: Record<string, unknown>,
	reason: string,
): Promise<boolean> {
	const detail = `${reason}\n\nTool: ${toolName}\nInput: ${JSON.stringify(input, null, 2)}`;
	if (ctx.hasUI)
		return controller.broker.requestWithFallback(
			toolName,
			input,
			reason,
			() => ctx.ui.confirm("SecHeur 权限确认", detail),
			ctx.signal,
		);
	return controller.broker.request(toolName, input, reason);
}

export function registerPermissionExtension(pi: ExtensionAPI, controller: PermissionController): void {
	pi.on("tool_call", async (event, ctx) => {
		const input = isRecord(event.input) ? event.input : {};
		const decision = controller.evaluate(event.toolName, input);
		if (decision.action === "allow") return undefined;
		if (decision.action === "deny") return { block: true, reason: decision.reason };
		const allowed = await confirmWithAvailableUi(controller, ctx, event.toolName, input, decision.reason);
		return allowed ? undefined : { block: true, reason: "User denied the permission request" };
	});
}
