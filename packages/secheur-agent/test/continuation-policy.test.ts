import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { writeDesktopConfig } from "../src/desktop-config.ts";
import type { CtfContinuationState, TrustedTaskIdentity } from "../src/extension.ts";
import { createSecHeurRuntime } from "../src/runtime.ts";

const temporaryRoots: string[] = [];

async function listenMockVerifier(response: Record<string, unknown>): Promise<{
	path: string;
	requests: Array<Record<string, unknown>>;
	close: () => Promise<void>;
}> {
	const path =
		process.platform === "win32"
			? `\\\\.\\pipe\\secheur-runtime-verifier-${randomUUID()}`
			: join(tmpdir(), `secheur-runtime-verifier-${randomUUID()}.sock`);
	const requests: Array<Record<string, unknown>> = [];
	const server = createServer((socket: Socket) => {
		let buffer = "";
		socket.on("data", (chunk: Buffer | string) => {
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			requests.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
			socket.end(`${JSON.stringify(response)}\n`);
		});
	});
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(path, () => {
			server.removeListener("error", reject);
			resolvePromise();
		});
	});
	return {
		path,
		requests,
		close: () =>
			new Promise<void>((resolvePromise, reject) => {
				server.close((error) => (error ? reject(error) : resolvePromise()));
			}),
	};
}

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "secheur-runtime-e2e-"));
	temporaryRoots.push(root);
	return root;
}

function contextText(messages: readonly unknown[]): string {
	return JSON.stringify(messages);
}

async function createCtfFauxRuntime(
	root: string,
	oracleSocket?: string,
	trustedTaskIdentity?: TrustedTaskIdentity,
	executionMode = "direct",
	cwd?: string,
) {
	writeDesktopConfig(root, {
		judge: { enabled: false },
		planning: { mode: executionMode === "plan_single" ? "active" : "off" },
	});
	const faux = fauxProvider({ models: [{ id: "faux-ctf", reasoning: true }] });
	const piDir = join(root, ".secheur-agent", "pi");
	mkdirSync(piDir, { recursive: true });
	writeFileSync(
		join(piDir, "auth.json"),
		JSON.stringify({ [faux.provider.id]: { type: "api_key", key: "faux-key" } }),
	);
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	const ctfContinuation: CtfContinuationState = {
		taskKind: "ctf",
		verificationState: "not_attempted",
		consecutiveNoToolTurns: 0,
	};
	const runtime = await createSecHeurRuntime({
		projectRoot: root,
		cwd,
		legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
		persist: false,
		model: faux.getModel(),
		modelRuntime,
		ctfContinuation,
		executionMode,
		trustedTaskIdentity,
		requireTrustedChallengeId: executionMode === "plan_single",
		env: {
			PATH: process.env.PATH,
			PI_OFFLINE: "1",
			SECHEUR_PYTHON: resolve(import.meta.dirname, "../../../.secheur-agent/python/bin/python"),
			CTF_ORACLE_CLIENT_ENV_FILE: join(root, "missing-oracle-client.env"),
			...(oracleSocket ? { CTF_ORACLE_SOCKET: oracleSocket } : {}),
		},
	});
	runtime.setMemoryReferenceEnabled(false);
	return { ctfContinuation, faux, runtime };
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CTF continuation stops only at verified success or external budgets", () => {
	it("survives multiple idle/action episodes, persistent recovery counts", async () => {
		const root = temporaryRoot();
		writeFileSync(join(root, "evidence.txt"), "synthetic witness");
		const { runtime, faux, ctfContinuation } = await createCtfFauxRuntime(root, undefined, {
			challengeId: "fixture/continue",
			runId: "fixture-run",
		});
		runtime.config.maxTurns = 10;
		runtime.setPermissionMode("bypassPermissions");
		const guard = runtime.state.operationalGuard!;
		for (let i = 0; i < 5; i++) guard.takeRecovery();
		const read = () => fauxAssistantMessage(fauxToolCall("read", { path: join(root, "evidence.txt") }));
		faux.setResponses([
			fauxAssistantMessage("idle one"),
			read(),
			fauxAssistantMessage("idle two"),
			read(),
			fauxAssistantMessage("idle three"),
			read(),
			() => {
				ctfContinuation.verificationState = "accepted";
				return fauxAssistantMessage("accepted by trusted fixture");
			},
		]);
		try {
			await runtime.prompt("Continue until trusted success or parent budget.");
			expect(faux.state.callCount).toBe(7);
			expect(runtime.getBudgetStatus().stopped).toBe(false);
			expect(guard.remainingAttempts).toBe(3);
		} finally {
			runtime.dispose();
		}
	}, 20000);
	it("does not stop for unlimited consecutive idle turns before the parent turn budget", async () => {
		const { runtime, faux } = await createCtfFauxRuntime(temporaryRoot(), undefined, {
			challengeId: "fixture/idle",
			runId: "fixture-idle",
		});
		runtime.config.maxTurns = 7;
		faux.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage("synthetic idle")));
		try {
			await runtime.prompt("Continue within parent budget.");
			expect(faux.state.callCount).toBe(7);
			expect(runtime.getBudgetStatus()).toMatchObject({ stopped: true, reason: "maxTurns", turnsUsed: 7 });
		} finally {
			runtime.dispose();
		}
	}, 20000);
	it("keeps ordinary tools available after verifier failure and prevents repeated verifier requests", async () => {
		const verifier = await listenMockVerifier({ ok: false, status: "backend_unavailable", verified: false });
		const { runtime, faux } = await createCtfFauxRuntime(temporaryRoot(), verifier.path, {
			challengeId: "fixture/unavailable",
			runId: "fixture-unavailable",
		});
		runtime.config.maxTurns = 7;
		runtime.setPermissionMode("bypassPermissions");
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf synthetic-proof" })),
			fauxAssistantMessage(fauxToolCall("verify_flag", { flag: "mock" })),
			fauxAssistantMessage(fauxToolCall("verify_flag", { flag: "different-mock" })),
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf still-working" })),
			fauxAssistantMessage("idle"),
			fauxAssistantMessage("idle again"),
			fauxAssistantMessage("last idle"),
		]);
		try {
			await runtime.prompt("A verifier failure must not stop other tools.");
			expect(verifier.requests).toHaveLength(1);
			expect(faux.state.callCount).toBe(7);
			expect(contextText(runtime.session.messages)).toContain("still-working");
			expect(runtime.getBudgetStatus().reason).toBe("maxTurns");
		} finally {
			runtime.dispose();
			await verifier.close();
		}
	}, 20000);
	it("delivers completed background work while verification allowance remains", async () => {
		const { runtime, faux, ctfContinuation } = await createCtfFauxRuntime(temporaryRoot(), undefined, {
			challengeId: "fixture/background",
			runId: "fixture-background",
		});
		runtime.config.maxTurns = 8;
		runtime.setPermissionMode("bypassPermissions");
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bash", { command: "sleep 0.05; printf background-continues", run_in_background: true }),
			),
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.2; printf foreground-witness" })),
			() => {
				ctfContinuation.verificationState = "accepted";
				return fauxAssistantMessage("trusted fixture accepted");
			},
		]);
		try {
			await runtime.prompt("Background work is independent of verifier allowance.");
			expect(contextText(runtime.session.messages)).toContain("background-continues");
			expect(runtime.state.commandTasks?.undeliveredCount).toBe(0);
		} finally {
			runtime.dispose();
		}
	}, 20000);
});

describe("length recovery yields to native Pi compaction", () => {
	it("compacts a truncated turn before resuming tools without spending the parent budget", async () => {
		const root = temporaryRoot();
		writeFileSync(join(root, "evidence.txt"), "synthetic witness");
		const { runtime, faux, ctfContinuation } = await createCtfFauxRuntime(root, undefined, {
			challengeId: "fixture/length",
			runId: "length-run",
		});
		runtime.config.maxTurns = 8;
		runtime.setPermissionMode("bypassPermissions");
		runtime.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const events: string[] = [];
		runtime.subscribe((e) => {
			if (e.type === "compaction_end" || e.type === "tool_execution_start") events.push(e.type);
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: join(root, "evidence.txt") })),
			fauxAssistantMessage("synthetic truncated response", { stopReason: "length" }),
			fauxAssistantMessage("Synthetic checkpoint summary; continue the fixture."),
			fauxAssistantMessage(fauxToolCall("read", { path: join(root, "evidence.txt") })),
			() => {
				ctfContinuation.verificationState = "accepted";
				return fauxAssistantMessage("trusted fixture accepted");
			},
		]);
		try {
			await runtime.prompt("Exercise harness length recovery with synthetic evidence only.");
			expect(events).toContain("compaction_end");
			expect(events.indexOf("compaction_end")).toBeLessThan(events.lastIndexOf("tool_execution_start"));
			expect(runtime.getBudgetStatus().stopped).toBe(false);
			expect(runtime.getBudgetStatus().turnsUsed).toBeLessThan(8);
			expect(ctfContinuation.verificationState).toBe("accepted");
		} finally {
			runtime.dispose();
		}
	}, 20000);
	it("does not resume after cancellation at the settling boundary", async () => {
		const { runtime, faux, ctfContinuation } = await createCtfFauxRuntime(temporaryRoot(), undefined, {
			challengeId: "fixture/cancel-length",
			runId: "cancel-length-run",
		});
		runtime.config.maxTurns = 8;
		faux.setResponses([
			() => {
				ctfContinuation.pendingLengthRecovery = true;
				void runtime.abort("user cancellation");
				return fauxAssistantMessage("synthetic aborted", { stopReason: "aborted" });
			},
		]);
		try {
			await runtime.prompt("Cancel fixture.");
			expect(faux.state.callCount).toBe(1);
		} finally {
			runtime.dispose();
		}
	}, 20000);
});
