import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { PiClient, type PiSessionHandle } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { ModelMetadataSchema } from "@earendil-works/pi-protocol";
import type { PiServer } from "@earendil-works/pi-server";
import { createUnixServer } from "@earendil-works/pi-server/unix";
import { createNodeSqliteFactory, SqliteSessionRepository } from "@earendil-works/pi-session-backend-sqlite-node";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { Check, Errors } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SecHeurProtocolService } from "../src/protocol-service.ts";

interface ProtocolStack {
	service: SecHeurProtocolService;
	server: PiServer;
	client: PiClient;
}

async function createModelRuntime() {
	const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function startStack(options: {
	root: string;
	databasePath: string;
	socketPath: string;
	modelRuntime: ModelRuntime;
	telemetryContext: InMemoryTelemetryContext;
}): Promise<ProtocolStack> {
	const service = await SecHeurProtocolService.create({
		projectRoot: options.root,
		stateDir: join(options.root, ".secheur-agent"),
		legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
		databasePath: options.databasePath,
		modelRuntime: options.modelRuntime,
		telemetryContext: options.telemetryContext,
		env: { PATH: process.env.PATH, PI_OFFLINE: "1" },
	});
	for (const model of await service.listModels()) {
		if (!Check(ModelMetadataSchema, model)) {
			throw new Error(JSON.stringify([...Errors(ModelMetadataSchema, model)]));
		}
	}
	const server = createUnixServer(service, { path: options.socketPath });
	try {
		await server.start();
		const client = await PiClient.connect({
			transportFactory: createUnixTransportFactory({ path: options.socketPath }),
		});
		return { service, server, client };
	} catch (error) {
		await server.close();
		await service.close();
		throw error;
	}
}

async function closeStack(stack: ProtocolStack, lease?: PiSessionHandle): Promise<void> {
	await lease?.dispose().catch(() => {});
	await stack.client.dispose();
	await stack.server.close();
	await stack.service.close();
}

describe.runIf(process.platform !== "win32")("SecHeur Pi protocol service", () => {
	it("waits for an in-flight session acquisition before closing repositories", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-protocol-close-race-"));
		const databasePath = join(root, "sessions.sqlite");
		const { faux, runtime: modelRuntime } = await createModelRuntime();
		const service = await SecHeurProtocolService.create({
			projectRoot: root,
			stateDir: join(root, ".secheur-agent"),
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			databasePath,
			modelRuntime,
			env: { PATH: process.env.PATH, PI_OFFLINE: "1" },
		});
		let reopened: SecHeurProtocolService | undefined;
		let reopenedRuntime: Awaited<ReturnType<SecHeurProtocolService["openSession"]>> | undefined;
		try {
			const entered = deferred();
			const release = deferred();
			const internals = service as unknown as {
				createRuntime: (options: unknown) => Promise<unknown>;
			};
			const createRuntime = internals.createRuntime.bind(service);
			internals.createRuntime = async (options) => {
				entered.resolve();
				await release.promise;
				return createRuntime(options);
			};
			const sessionId = "close-race-session";
			const acquisition = service.createSession({
				id: sessionId,
				model: { provider: faux.provider.id, id: faux.getModel().id },
			});
			await entered.promise;
			let closeSettled = false;
			const closing = service.close().then(() => {
				closeSettled = true;
			});
			await Promise.resolve();
			expect(closeSettled).toBe(false);

			release.resolve();
			await acquisition;
			await closing;

			reopened = await SecHeurProtocolService.create({
				projectRoot: root,
				stateDir: join(root, ".secheur-agent"),
				legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
				databasePath,
				modelRuntime,
				env: { PATH: process.env.PATH, PI_OFFLINE: "1" },
			});
			reopenedRuntime = await reopened.openSession(sessionId);
			expect(await reopenedRuntime.snapshot()).toMatchObject({ id: sessionId });
		} finally {
			await reopenedRuntime?.dispose().catch(() => {});
			await reopened?.close().catch(() => {});
			await service.close().catch(() => {});
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("waits for in-flight runtime storage operations before disposing a session", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-protocol-operation-race-"));
		const databasePath = join(root, "sessions.sqlite");
		const { faux, runtime: modelRuntime } = await createModelRuntime();
		const service = await SecHeurProtocolService.create({
			projectRoot: root,
			stateDir: join(root, ".secheur-agent"),
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			databasePath,
			modelRuntime,
			env: { PATH: process.env.PATH, PI_OFFLINE: "1" },
		});
		const runtime = await service.createSession({
			id: "operation-race-session",
			model: { provider: faux.provider.id, id: faux.getModel().id },
		});
		const entered = deferred();
		const release = deferred();
		const internals = runtime as unknown as {
			persistState: () => Promise<void>;
			repository: { close: () => Promise<void> };
			storage: { findEntries: (...args: unknown[]) => Promise<unknown> };
		};
		const findEntries = internals.storage.findEntries.bind(internals.storage);
		const closeRepository = internals.repository.close.bind(internals.repository);
		let repositoryCloseStarted = false;
		internals.storage.findEntries = async (...args) => {
			entered.resolve();
			await release.promise;
			return findEntries(...args);
		};
		internals.persistState = async () => undefined;
		internals.repository.close = async () => {
			repositoryCloseStarted = true;
		};
		try {
			const snapshot = runtime.snapshot();
			await entered.promise;
			const closing = service.close();
			await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
			expect(repositoryCloseStarted).toBe(false);

			release.resolve();
			await snapshot;
			await closing;
			expect(repositoryCloseStarted).toBe(true);
		} finally {
			release.resolve();
			await service.close().catch(() => {});
			await closeRepository().catch(() => {});
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves one session ID across Unix clients, JSONL, SQLite, and service restarts", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-protocol-"));
		const databasePath = join(root, "sessions.sqlite");
		const socketPath = join(root, "secheur.sock");
		const telemetry = new InMemoryTelemetryContext();
		const { faux, runtime: modelRuntime } = await createModelRuntime();
		let first: ProtocolStack | undefined;
		let second: ProtocolStack | undefined;
		let third: ProtocolStack | undefined;
		let firstLease: PiSessionHandle | undefined;
		let secondLease: PiSessionHandle | undefined;
		let thirdLease: PiSessionHandle | undefined;
		try {
			first = await startStack({ root, databasePath, socketPath, modelRuntime, telemetryContext: telemetry });
			firstLease = await first.client.createSession({
				name: "Protocol test",
				model: { provider: faux.provider.id, id: faux.getModel().id },
				thinkingLevel: "high",
			});
			const sessionId = firstLease.id;
			expect(firstLease.snapshot).toMatchObject({
				id: sessionId,
				name: "Protocol test",
				thinkingLevel: "high",
				transcript: [],
			});

			await closeStack(first, firstLease);
			first = undefined;
			firstLease = undefined;

			const recovery = new SqliteSessionRepository({
				env: new NodeExecutionEnv({ cwd: root }),
				sqlite: createNodeSqliteFactory(),
				databasePath,
			});
			try {
				const [metadata] = await recovery.list();
				if (!metadata) throw new Error("Missing protocol session metadata");
				const stored = await recovery.open(metadata);
				await stored.appendEntry(
					{
						type: "message",
						id: "sqlite-recovery-user",
						message: { role: "user", content: "recovered request", timestamp: Date.now() },
					},
					"main",
				);
			} finally {
				await recovery.close();
			}

			second = await startStack({ root, databasePath, socketPath, modelRuntime, telemetryContext: telemetry });
			expect(await second.client.listSessions()).toContainEqual(
				expect.objectContaining({ id: sessionId, sessionName: "Protocol test", cwd: root }),
			);
			secondLease = await second.client.attachSession(sessionId);
			expect(secondLease.snapshot).toMatchObject({
				id: sessionId,
				thinkingLevel: "high",
				transcript: [{ role: "user", content: [{ type: "text", text: "recovered request" }] }],
			});

			faux.setResponses([
				async (context, options) => {
					const userTexts = context.messages.flatMap((message) => {
						if (message.role !== "user") return [];
						if (typeof message.content === "string") return [message.content];
						return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
					});
					expect(userTexts).toEqual(["recovered request", "protocol request"]);
					if (!options?.telemetryContext) throw new Error("Missing provider telemetry context");
					await options.telemetryContext.startSpan({ name: "test.provider" }, async () => {});
					return fauxAssistantMessage("protocol reply");
				},
			]);
			const progress: string[] = [];
			const unsubscribe = secondLease.onEvent((event) => {
				if (event.type === "session_progress") progress.push(event.progress.type);
			});
			const prompted = await secondLease.prompt("protocol request");
			unsubscribe();
			expect(prompted.transcript).toMatchObject([
				{ role: "user", content: [{ type: "text", text: "recovered request" }] },
				{ role: "user", content: [{ type: "text", text: "protocol request" }] },
				{
					role: "assistant",
					status: "complete",
					stopReason: "stop",
					content: [{ type: "text", text: "protocol reply" }],
				},
			]);
			expect(progress).toContain("item_started");
			expect(progress).toContain("assistant_delta");
			expect(progress).toContain("item_finished");

			const spans = telemetry.getSpans();
			const promptSpan = spans.find((span) => span.name === "secheur.runtime.prompt");
			const providerSpan = spans.find((span) => span.name === "test.provider");
			expect(spans.some((span) => span.name === "secheur.runtime.create" && span.settled)).toBe(true);
			expect(promptSpan).toMatchObject({ settled: true, status: { status: "ok" } });
			expect(providerSpan?.parentId).toBe(promptSpan?.id);

			await closeStack(second, secondLease);
			second = undefined;
			secondLease = undefined;

			const inspection = new SqliteSessionRepository({
				env: new NodeExecutionEnv({ cwd: root }),
				sqlite: createNodeSqliteFactory(),
				databasePath,
			});
			try {
				const [metadata] = await inspection.list();
				expect(metadata).toMatchObject({ id: sessionId, name: "Protocol test", cwd: root });
				if (!metadata) throw new Error("Missing protocol session metadata");
				const stored = await inspection.open(metadata);
				const messages = await stored.findEntries({ type: "message", order: "oldestFirst" });
				expect(messages).toHaveLength(3);
				expect(messages.map((entry) => (entry.type === "message" ? entry.message.role : undefined))).toEqual([
					"user",
					"user",
					"assistant",
				]);
			} finally {
				await inspection.close();
			}

			const agentDir = join(root, ".secheur-agent", "pi");
			const sessionDirectory = join(
				agentDir,
				"sessions",
				`--${root.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
			);
			const jsonlSessions = await SessionManager.list(root, sessionDirectory);
			expect(jsonlSessions).toContainEqual(expect.objectContaining({ id: sessionId }));

			third = await startStack({ root, databasePath, socketPath, modelRuntime, telemetryContext: telemetry });
			thirdLease = await third.client.attachSession(sessionId);
			expect(thirdLease.snapshot).toMatchObject({
				id: sessionId,
				name: "Protocol test",
				transcript: [
					{ role: "user", content: [{ type: "text", text: "recovered request" }] },
					{ role: "user", content: [{ type: "text", text: "protocol request" }] },
					{ role: "assistant", content: [{ type: "text", text: "protocol reply" }] },
				],
			});
		} finally {
			if (third) await closeStack(third, thirdLease);
			if (second) await closeStack(second, secondLease);
			if (first) await closeStack(first, firstLease);
			faux.setResponses([]);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
