/**
 * Offline end-to-end self-test for SecHeur Agent.
 *
 * `secheur self-test` runs this module with a temporary project root and
 * temporary state, exercising every locally reachable subsystem without
 * contacting the network, real providers, or any production config:
 *
 *   - legacy Python runtime probe (`inspectLegacyEnvironment`).
 *   - real `LegacyToolHost` calls for `tool_search`, `list_files`, and
 *     `attack_memory_search`.
 *   - a stdio MCP fixture launched from this package, exercised through
 *     `McpManager` (`tools/list`, `tools/call`, `structuredContent`,
 *     disconnect + reconnect).
 *   - `SecHeurBridge` on an ephemeral port: `/status`, `/`, `/app.js`,
 *     and a raw WebSocket handshake against `/ws`.
 *   - `SecHeurProtocolService` with a faux provider and SQLite: create a
 *     session, send a prompt, close the stack, reopen it, and verify the
 *     session ID + transcript survive.
 *   - bundled Skill discovery from `.pi/skills/`.
 *
 * Each step emits a record with `pass`, `durationMs`, and `error`.
 * The CLI dispatcher in `cli.ts` formats the report for humans or JSON.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { type AddressInfo, createConnection as netCreateConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { PiClient, type PiSessionHandle } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createUnixServer } from "@earendil-works/pi-server/unix";
import { createNodeSqliteFactory, SqliteSessionRepository } from "@earendil-works/pi-session-backend-sqlite-node";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { SecHeurBridge } from "./bridge.ts";
import { type LoadSecHeurConfigOptions, loadSecHeurConfig, type McpServerConfig } from "./config.ts";
import { LegacyToolHost } from "./legacy-host.ts";
import { type McpExposedTool, McpManager } from "./mcp.ts";
import { SecHeurProtocolService } from "./protocol-service.ts";
import { formatLegacyEnvironmentReport, inspectLegacyEnvironment } from "./python-runtime.ts";

export interface SelfTestStep {
	id: string;
	label: string;
	pass: boolean;
	durationMs: number;
	error?: string;
	details?: Record<string, unknown>;
}

export interface SelfTestReport {
	ok: boolean;
	totalDurationMs: number;
	workspace: string;
	steps: SelfTestStep[];
}

export interface RunSelfTestOptions extends LoadSecHeurConfigOptions {
	json?: boolean;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const FIXTURE_RELATIVE_PATH = ["test", "fixtures", "mcp-stdio-fixture.js"] as const;
const PROTOCOL_TIMEOUT_MS = 30_000;
const PROTOCOL_PROMPT_TEXT = "self-test prompt";
const BRIDGE_HOST = "127.0.0.1";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localPackageRoot(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return resolve(here, "..");
}

function fixtureScriptPath(): string {
	return join(localPackageRoot(), ...FIXTURE_RELATIVE_PATH);
}

async function runStep(id: string, label: string, operation: () => Promise<SelfTestStep>): Promise<SelfTestStep> {
	const started = Date.now();
	try {
		const result = await operation();
		if (!result.durationMs) result.durationMs = Date.now() - started;
		if (!result.pass && !result.error) {
			result.error = "step returned without pass=true";
		}
		return result;
	} catch (error) {
		return {
			id,
			label,
			pass: false,
			durationMs: Date.now() - started,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function probeLegacyRuntime(options: LoadSecHeurConfigOptions): Promise<SelfTestStep> {
	return runStep("legacy-runtime", "Inspect bundled legacy runtime + Python environment", async () => {
		const config = loadSecHeurConfig(options);
		const diagnostic = inspectLegacyEnvironment(config);
		if (!diagnostic.ready) throw new Error(formatLegacyEnvironmentReport(diagnostic));
		return {
			id: "legacy-runtime",
			label: "Inspect bundled legacy runtime + Python environment",
			pass: true,
			durationMs: 0,
			details: {
				ready: diagnostic.ready,
				pythonVersion: diagnostic.pythonVersion,
				legacyRoot: diagnostic.legacyRoot,
				bridgePath: diagnostic.bridgePath,
				missingPackages: diagnostic.missingPackages,
			},
		};
	});
}

async function invokeLegacyTools(options: LoadSecHeurConfigOptions, workspace: string): Promise<SelfTestStep[]> {
	const host = new LegacyToolHost(loadSecHeurConfig(options), () => "bypassPermissions", {
		...(options.env ?? process.env),
		PYTHONDONTWRITEBYTECODE: "1",
		SECHEUR_PERMISSION_MODE: "bypassPermissions",
		PI_OFFLINE: "1",
	});
	host.setKnowledgeBaseEnabled(true);
	const calls: Array<{
		id: string;
		label: string;
		tool: string;
		args: Record<string, unknown>;
		assert: (response: { ok: boolean; content?: string; data?: unknown; error?: string }) => void;
	}> = [
		{
			id: "legacy-tool-search",
			label: "LegacyToolHost -> tool_search",
			tool: "tool_search",
			args: { query: "search", limit: 5 },
			assert: (response) => {
				if (!response.ok) throw new Error(response.error ?? "tool_search failed");
				if (typeof response.content !== "string" || !response.content.trim()) {
					throw new Error("tool_search returned empty content");
				}
			},
		},
		{
			id: "legacy-list-files",
			label: "LegacyToolHost -> list_files",
			tool: "list_files",
			args: { pattern: join(workspace, "*"), maxEntries: 25 },
			assert: (response) => {
				if (!response.ok) throw new Error(response.error ?? "list_files failed");
				if (typeof response.content !== "string" || !response.content.trim()) {
					throw new Error("list_files returned empty content");
				}
			},
		},
		{
			id: "legacy-attack-memory",
			label: "LegacyToolHost -> attack_memory_search",
			tool: "attack_memory_search",
			args: { query: "self-test", limit: 5 },
			assert: (response) => {
				if (!response.ok) throw new Error(response.error ?? "attack_memory_search failed");
				if (typeof response.content !== "string" || !response.content.trim()) {
					throw new Error("attack_memory_search returned empty content");
				}
			},
		},
	];
	const steps: SelfTestStep[] = [];
	try {
		for (const call of calls) {
			steps.push(
				await runStep(call.id, call.label, async () => {
					const started = Date.now();
					const response = await host.call(call.tool, call.args, undefined, 30_000);
					call.assert(response);
					return {
						id: call.id,
						label: call.label,
						pass: true,
						durationMs: Date.now() - started,
					};
				}),
			);
		}
	} finally {
		host.close();
	}
	return steps;
}

async function exerciseMcpFixture(workspace: string): Promise<McpExposedTool[]> {
	const fixturePath = fixtureScriptPath();
	if (!existsSync(fixturePath)) throw new Error(`Missing MCP fixture: ${fixturePath}`);
	const config: Record<string, McpServerConfig> = {
		"self-test": {
			transport: "stdio",
			command: process.execPath,
			args: [fixturePath],
			env: {},
			cwd: workspace,
			timeoutMs: 15_000,
			protocolVersion: "2025-11-25",
		},
	};
	const manager = new McpManager(config);
	let exposed: McpExposedTool[] = [];
	try {
		exposed = await manager.refresh();
		if (exposed.length < 2) throw new Error(`Expected >=2 exposed tools, got ${exposed.length}`);
		const statusTool = exposed.find((tool) => tool.name === "status");
		const echoTool = exposed.find((tool) => tool.name === "echo");
		if (!statusTool) throw new Error("Fixture did not expose `status` tool");
		if (!echoTool) throw new Error("Fixture did not expose `echo` tool");
		const result = await manager.callTool(echoTool.exposedName, { text: "ping" });
		const text = result.content.find((part) => part.type === "text");
		if (!text || !text.text.includes("ping")) throw new Error(`echo text missing: ${JSON.stringify(result.content)}`);
		if (
			!result.structuredContent ||
			!isRecord(result.structuredContent) ||
			result.structuredContent.echoed !== "ping"
		) {
			throw new Error(`structuredContent missing: ${JSON.stringify(result.structuredContent)}`);
		}
	} finally {
		await manager.close().catch(() => undefined);
	}

	const managerSecond = new McpManager(config);
	try {
		await managerSecond.refresh();
		const statusTool = managerSecond.exposedTools.find((tool) => tool.name === "status");
		if (!statusTool) throw new Error("Reconnect did not re-expose `status` tool");
		const result = await managerSecond.callTool(statusTool.exposedName, { label: "reconnect" });
		if (
			!result.structuredContent ||
			!isRecord(result.structuredContent) ||
			result.structuredContent.label !== "reconnect"
		) {
			throw new Error(`structuredContent missing after reconnect: ${JSON.stringify(result.structuredContent)}`);
		}
	} finally {
		await managerSecond.close().catch(() => undefined);
	}
	return exposed;
}

export async function probeMcpFixture(options: LoadSecHeurConfigOptions): Promise<SelfTestStep> {
	const id = "mcp-fixture";
	const label = "Spawn stdio MCP fixture (list/call/structuredContent/reconnect)";
	return runStep(id, label, async () => {
		const config = loadSecHeurConfig(options);
		const exposed = await exerciseMcpFixture(config.projectRoot);
		return {
			id,
			label,
			pass: true,
			durationMs: 0,
			details: {
				exposedTools: exposed.map((tool) => tool.exposedName),
			},
		};
	});
}

export async function probeBridgeHttp(options: LoadSecHeurConfigOptions): Promise<SelfTestStep> {
	const id = "bridge-http";
	const label = "Bridge HTTP routes (/status, /, /app.js)";
	return runStep(id, label, async () => {
		const started = Date.now();
		const config = loadSecHeurConfig(options);
		const bridge = new SecHeurBridge({
			projectRoot: config.projectRoot,
			host: BRIDGE_HOST,
			port: 0,
			schedulerBackend: false,
			env: process.env,
		});
		try {
			await bridge.listen();
			const address = bridge.address;
			if (!address.port) throw new Error(`Bridge did not bind a real port: ${JSON.stringify(address)}`);
			const statusResponse = await fetch(`http://${BRIDGE_HOST}:${address.port}/status`);
			if (!statusResponse.ok) throw new Error(`/status returned HTTP ${statusResponse.status}`);
			const statusPayload = (await statusResponse.json()) as Record<string, unknown>;
			if (statusPayload.ready !== true) throw new Error(`/status not ready: ${JSON.stringify(statusPayload)}`);
			const rootResponse = await fetch(`http://${BRIDGE_HOST}:${address.port}/`);
			if (!rootResponse.ok) throw new Error(`/ returned HTTP ${rootResponse.status}`);
			const rootText = await rootResponse.text();
			if (rootText.length === 0) throw new Error("/ returned empty body");
			const appResponse = await fetch(`http://${BRIDGE_HOST}:${address.port}/app.js`);
			if (!appResponse.ok) throw new Error(`/app.js returned HTTP ${appResponse.status}`);
			const appText = await appResponse.text();
			if (appText.length === 0) throw new Error("/app.js returned empty body");
			return {
				id,
				label,
				pass: true,
				durationMs: Date.now() - started,
				details: {
					address,
					rootBytes: rootText.length,
					appJsBytes: appText.length,
				},
			};
		} finally {
			await bridge.close().catch(() => undefined);
		}
	});
}

export async function probeBridgeWebSocket(options: LoadSecHeurConfigOptions): Promise<SelfTestStep> {
	const id = "bridge-websocket";
	const label = "Bridge WebSocket handshake on /ws";
	return runStep(id, label, async () => {
		const started = Date.now();
		const config = loadSecHeurConfig(options);
		const bridge = new SecHeurBridge({
			projectRoot: config.projectRoot,
			host: BRIDGE_HOST,
			port: 0,
			schedulerBackend: false,
			env: process.env,
		});
		try {
			await bridge.listen();
			const address = bridge.address;
			const key = createHash("sha1").update(`secheur-self-test-${Date.now()}`).digest("base64");
			const handshake = await new Promise<{ statusLine: string; headers: Map<string, string>; socket: Socket }>(
				(resolve, reject) => {
					const socket = netCreateConnection({ host: BRIDGE_HOST, port: address.port }, () => {
						const request =
							`GET /ws HTTP/1.1\r\n` +
							`Host: ${BRIDGE_HOST}:${address.port}\r\n` +
							`Connection: Upgrade\r\n` +
							`Upgrade: websocket\r\n` +
							`Sec-WebSocket-Version: 13\r\n` +
							`Sec-WebSocket-Key: ${key}\r\n` +
							`\r\n`;
						socket.write(request);
					});
					let buffer = "";
					const headers = new Map<string, string>();
					const onData = (chunk: Buffer): void => {
						buffer += chunk.toString("utf8");
						const separator = buffer.indexOf("\r\n\r\n");
						if (separator < 0) return;
						const headerText = buffer.slice(0, separator);
						const lines = headerText.split("\r\n");
						const statusLine = lines.shift() ?? "";
						for (const line of lines) {
							const colon = line.indexOf(":");
							if (colon < 0) continue;
							const name = line.slice(0, colon).trim().toLowerCase();
							const value = line.slice(colon + 1).trim();
							if (name) headers.set(name, value);
						}
						socket.off("data", onData);
						resolve({ statusLine, headers, socket });
					};
					socket.on("data", onData);
					socket.once("error", reject);
				},
			);
			try {
				if (!handshake.statusLine.toLowerCase().startsWith("http/1.1 101")) {
					throw new Error(`WebSocket handshake failed: ${handshake.statusLine}`);
				}
				if (handshake.headers.get("upgrade")?.toLowerCase() !== "websocket") {
					throw new Error(`Upgrade header missing: ${handshake.statusLine}`);
				}
				if (!handshake.headers.get("sec-websocket-accept")) {
					throw new Error("Sec-WebSocket-Accept missing");
				}
				return {
					id,
					label,
					pass: true,
					durationMs: Date.now() - started,
					details: {
						statusLine: handshake.statusLine,
						upgrade: handshake.headers.get("upgrade"),
					},
				};
			} finally {
				handshake.socket.destroy();
			}
		} finally {
			await bridge.close().catch(() => undefined);
		}
	});
}

async function createModelRuntime(): Promise<{ faux: ReturnType<typeof fauxProvider>; runtime: ModelRuntime }> {
	const faux = fauxProvider({ models: [{ id: "faux-self", reasoning: true }] });
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "faux-key" }));
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		refreshOnCreate: false,
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	return { faux, runtime };
}

export async function probeProtocol(options: LoadSecHeurConfigOptions, workspace: string): Promise<SelfTestStep> {
	const id = "protocol";
	const label = "Unix protocol server + SQLite (session ID and transcript survive restart)";
	return runStep(id, label, async () => {
		const started = Date.now();
		const config = loadSecHeurConfig(options);
		const databasePath = join(workspace, "sessions.sqlite");
		const socketPath = join(workspace, "secheur.sock");
		const telemetry = new InMemoryTelemetryContext();
		const { faux, runtime: modelRuntime } = await createModelRuntime();
		const serviceOptions = {
			projectRoot: workspace,
			stateDir: join(workspace, ".secheur-agent"),
			legacyRoot: config.legacyRoot,
			databasePath,
			modelRuntime,
			telemetryContext: telemetry,
			env: { PATH: process.env.PATH ?? "", PI_OFFLINE: "1" },
		};
		let firstService: SecHeurProtocolService | undefined;
		let firstServer: ReturnType<typeof createUnixServer> | undefined;
		let firstClient: PiClient | undefined;
		let firstLease: PiSessionHandle | undefined;
		try {
			firstService = await SecHeurProtocolService.create(serviceOptions);
			firstServer = createUnixServer(firstService, { path: socketPath });
			await firstServer.start();
			firstClient = await PiClient.connect({
				transportFactory: createUnixTransportFactory({ path: socketPath }),
			});
			faux.setResponses([async () => fauxAssistantMessage("self-test reply")]);
			firstLease = await firstClient.createSession({
				name: "self-test",
				model: { provider: faux.provider.id, id: faux.getModel().id },
				thinkingLevel: "medium",
			});
			const sessionId = firstLease.id;
			const prompted = await Promise.race([
				firstLease.prompt(PROTOCOL_PROMPT_TEXT),
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error(`Protocol prompt timed out after ${PROTOCOL_TIMEOUT_MS}ms`)),
						PROTOCOL_TIMEOUT_MS,
					),
				),
			]);
			if (prompted.transcript.length < 2) {
				throw new Error(`Expected transcript with user + assistant, got ${prompted.transcript.length} items`);
			}
			await firstClient.dispose().catch(() => undefined);
			await firstServer.close().catch(() => undefined);
			await firstService.close().catch(() => undefined);
			firstClient = undefined;
			firstServer = undefined;
			firstService = undefined;

			const repository = new SqliteSessionRepository({
				env: new NodeExecutionEnv({ cwd: workspace }),
				sqlite: createNodeSqliteFactory(),
				databasePath,
			});
			try {
				const listed = await repository.list();
				if (!listed.some((entry) => entry.id === sessionId)) {
					throw new Error(`SQLite lost session ${sessionId} after first close`);
				}
			} finally {
				await repository.close();
			}

			const reopened = await SecHeurProtocolService.create(serviceOptions);
			const reopenedServer = createUnixServer(reopened, { path: socketPath });
			let reopenedClient: PiClient | undefined;
			try {
				await reopenedServer.start();
				reopenedClient = await PiClient.connect({
					transportFactory: createUnixTransportFactory({ path: socketPath }),
				});
				const lease = await reopenedClient.attachSession(sessionId);
				const snapshot = lease.snapshot;
				if (!snapshot) throw new Error("Reattached session produced no snapshot");
				if (snapshot.id !== sessionId) {
					throw new Error(`Session ID changed: was ${sessionId}, now ${snapshot.id}`);
				}
				if (!snapshot.transcript.some((item) => item.role === "assistant")) {
					throw new Error("Transcript lost assistant message after restart");
				}
				if (
					!snapshot.transcript.some(
						(item) =>
							item.role === "user" &&
							item.content.some((part) => part.type === "text" && part.text === PROTOCOL_PROMPT_TEXT),
					)
				) {
					throw new Error("Transcript lost original user prompt after restart");
				}
				await lease.dispose();
				return {
					id,
					label,
					pass: true,
					durationMs: Date.now() - started,
					details: {
						sessionId,
						transcriptLength: snapshot.transcript.length,
						transcriptRoles: snapshot.transcript.map((item) => item.role),
					},
				};
			} finally {
				await reopenedClient?.dispose().catch(() => undefined);
				await reopenedServer.close().catch(() => undefined);
				await reopened.close();
			}
		} finally {
			await firstLease?.dispose().catch(() => undefined);
			await firstClient?.dispose().catch(() => undefined);
			await firstServer?.close().catch(() => undefined);
			await firstService?.close().catch(() => undefined);
		}
	});
}

export async function probeSkills(options: LoadSecHeurConfigOptions): Promise<SelfTestStep> {
	const id = "skills";
	const label = "Discover bundled Skills";
	return runStep(id, label, async () => {
		const started = Date.now();
		const config = loadSecHeurConfig(options);
		const candidates = new Set<string>(config.skillPaths);
		const localSkills = join(localPackageRoot(), ".pi", "skills");
		if (existsSync(localSkills)) candidates.add(localSkills);
		const seen = new Map<string, { path: string; description?: string }>();
		for (const directory of candidates) {
			if (!existsSync(directory)) continue;
			const entries = readdirSync(directory, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const skillFile = join(directory, entry.name, "SKILL.md");
				if (!existsSync(skillFile)) continue;
				const description = extractSkillDescription(skillFile);
				seen.set(entry.name, { path: skillFile, description });
			}
		}
		if (seen.size === 0) throw new Error(`No SKILL.md found under: ${[...candidates].join(", ")}`);
		return {
			id,
			label,
			pass: true,
			durationMs: Date.now() - started,
			details: {
				searchPaths: [...candidates],
				discovered: [...seen.entries()].map(([name, info]) => ({
					name,
					path: info.path,
					description: info.description ?? null,
				})),
				count: seen.size,
			},
		};
	});
}

function extractSkillDescription(skillPath: string): string | undefined {
	try {
		const text = readFileSync(skillPath, "utf8");
		for (const line of text.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed === "---") continue;
			if (trimmed.startsWith("description:")) return trimmed.slice("description:".length).trim();
			return undefined;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export async function runSelfTest(options: RunSelfTestOptions = {}): Promise<SelfTestReport> {
	const config = loadSecHeurConfig(options);
	const startedAt = Date.now();
	const steps: SelfTestStep[] = [];

	steps.push(await probeLegacyRuntime(options));
	steps.push(...(await invokeLegacyTools(options, config.projectRoot)));
	steps.push(await probeBridgeHttp(options));
	steps.push(await probeBridgeWebSocket(options));
	steps.push(await probeMcpFixture(options));
	steps.push(await probeProtocol(options, config.projectRoot));
	steps.push(await probeSkills(options));

	const ok = steps.every((step) => step.pass);
	return {
		ok,
		totalDurationMs: Date.now() - startedAt,
		workspace: config.projectRoot,
		steps,
	};
}

export async function runIsolatedSelfTest(options: RunSelfTestOptions = {}): Promise<SelfTestReport> {
	const sourceConfig = loadSecHeurConfig(options);
	const workspace = mkdtempSync(join(tmpdir(), "secheur-self-test-"));
	const stateDir = join(workspace, ".secheur-agent");
	try {
		return await runSelfTest({
			...options,
			projectRoot: workspace,
			stateDir,
			legacyRoot: sourceConfig.legacyRoot,
			env: {
				...(options.env ?? process.env),
				PI_OFFLINE: "1",
				SECHEUR_PROJECT_ROOT: workspace,
				SECHEUR_CONFIG_DIR: stateDir,
				SECHEUR_AGENT_DIR: join(stateDir, "pi"),
				SECHEUR_LEGACY_ROOT: sourceConfig.legacyRoot,
				SECHEUR_PYTHON: sourceConfig.pythonExecutable,
			},
		});
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

export function formatSelfTestText(report: SelfTestReport): string {
	const lines: string[] = [];
	lines.push(report.ok ? "SecHeur self-test: PASS" : "SecHeur self-test: FAIL");
	lines.push(`Workspace: ${report.workspace}`);
	lines.push(`Duration: ${report.totalDurationMs}ms`);
	lines.push("");
	for (const step of report.steps) {
		const status = step.pass ? "PASS" : "FAIL";
		lines.push(`[${status}] ${step.id} (${step.durationMs}ms) — ${step.label}`);
		if (step.error) lines.push(`        ${step.error}`);
	}
	return lines.join("\n");
}

export function formatSelfTestJson(report: SelfTestReport): string {
	return JSON.stringify(report, null, 2);
}

export function selfTestTimeoutMs(options: RunSelfTestOptions = {}): number {
	return options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

export function selfTestTmpRoot(): string {
	return tmpdir();
}

// Reserved helpers for downstream tooling (tests, debug scripts).
export const __testingHelpers = { selfTestTmpRoot };

// Re-export node types to avoid duplicate imports in downstream tools.
export type { AddressInfo, ChildProcessWithoutNullStreams };
export { spawn };
