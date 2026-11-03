import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FlagOracleAbortedError,
	FlagOracleClient,
	FlagOracleTimeoutError,
	FlagOracleUnavailableError,
	flagOracleConfigured,
	flagOracleSummary,
} from "../src/flag-oracle.ts";

const verifierServers: ReturnType<typeof createServer>[] = [];

async function listenVerifierSocket(
	handle: (socket: Socket, request: Record<string, unknown>) => void,
): Promise<string> {
	const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\secheur-verify-${randomUUID()}` : join(tmpdir(), `secheur-verify-${randomUUID()}.sock`);
	const server = createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			const request = JSON.parse(line) as Record<string, unknown>;
			handle(socket, request);
		});
	});
	verifierServers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	return socketPath;
}

async function closeVerifierServers(): Promise<void> {
	for (const server of verifierServers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

afterEach(async () => {
	vi.restoreAllMocks();
	await closeVerifierServers();
});

describe("Flag Oracle client", () => {
	it("detects configured remote or local verification credentials without exposing them", () => {
		expect(flagOracleConfigured({ CTF_ORACLE_CLIENT_ENV_FILE: "/missing/oracle.env" })).toBe(false);
		expect(flagOracleConfigured({ CTF_ORACLE_SOCKET: "/run/secheur-flag-oracle/verify.sock" })).toBe(true);
		expect(flagOracleConfigured({ CTF_ORACLE_TOKEN: "fixture-token" })).toBe(true);
	});

	it("cancels an oversized response stream", async () => {
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(1_000_001));
			},
			cancel,
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 200 }));

		await expect(
			flagOracleSummary(
				{
					CTF_ORACLE_URL: "http://127.0.0.1:18181",
					CTF_ORACLE_TOKEN: "fixture-token",
					CTF_ORACLE_CLIENT_ENV_FILE: "/missing/oracle.env",
				},
				1,
			),
		).rejects.toThrow("Flag Oracle response exceeded 1000000 bytes");
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("uses the native verifier socket wire contract", async () => {
		let request: Record<string, unknown> | undefined;
		const socketPath = await listenVerifierSocket((socket, received) => {
			request = received;
			socket.end(JSON.stringify({ ok: true, status: "correct", verified: true }) + "\n");
		});
		const result = await new FlagOracleClient({ CTF_ORACLE_SOCKET: socketPath }).verify({
			flag: "flag{ok}",
			challengeId: "intercode-ctf/1",
			agentId: "agent-1",
			runId: "run-1",
		});
		expect(request).toEqual({
			flag: "flag{ok}",
			challenge_id: "intercode-ctf/1",
			agent_id: "agent-1",
			run_id: "run-1",
		});
		expect(result).toMatchObject({
			ok: true,
			status: "correct",
			verified: true,
			correct: true,
			verificationOutcome: "correct",
		});
	});

	it("treats an incorrect flag as normal verifier feedback", async () => {
		const socketPath = await listenVerifierSocket((socket) => {
			socket.end(JSON.stringify({ ok: false, status: "incorrect", verified: false }) + "\n");
		});
		await expect(
			new FlagOracleClient({ CTF_ORACLE_SOCKET: socketPath }).verify({
				flag: "flag{wrong}",
				challengeId: "intercode-ctf/1",
			}),
		).resolves.toMatchObject({
			ok: true,
			status: "incorrect",
			verified: false,
			verificationOutcome: "incorrect",
		});
	});

	it.each(["duplicate", "attempt_limit_reached", "limit_exceeded"])(
		"preserves the Oracle/Proxy status semantics for %s",
		async (status) => {
			const socketPath = await listenVerifierSocket((socket) => {
				socket.end(`${JSON.stringify({ ok: false, status, verified: false })}\n`);
			});
			const result = await new FlagOracleClient({ CTF_ORACLE_SOCKET: socketPath }).verify({
				flag: "flag{candidate}",
				challengeId: "intercode-ctf/1",
			});
			if (status === "duplicate") {
				expect(result).toMatchObject({
					ok: true,
					status,
					verified: false,
					correct: false,
					verificationOutcome: "incorrect",
				});
				return;
			}
			expect(result).toMatchObject({
				ok: false,
				status,
				verified: false,
				correct: false,
				verificationOutcome: "infra_error",
				failureCategory: "quota_exhausted",
			});
		},
	);

	it("keeps invalid requests machine-readable as infrastructure errors", async () => {
		const socketPath = await listenVerifierSocket((socket) => {
			socket.end(JSON.stringify({ ok: false, status: "invalid_request", error: "challenge_id is required" }) + "\n");
		});
		await expect(
			new FlagOracleClient({ CTF_ORACLE_SOCKET: socketPath }).verify({ flag: "flag{wrong}" }),
		).resolves.toMatchObject({
			ok: false,
			status: "invalid_request",
			verificationOutcome: "infra_error",
			failureCategory: "invalid_request",
		});
	});

	it("does not accept a malformed correct response", async () => {
		const socketPath = await listenVerifierSocket((socket) => {
			socket.end(JSON.stringify({ ok: false, status: "correct", verified: true }) + "\n");
		});
		await expect(
			new FlagOracleClient({ CTF_ORACLE_SOCKET: socketPath }).verify({
				flag: "flag{malformed}",
				challengeId: "intercode-ctf/1",
			}),
		).resolves.toMatchObject({
			ok: false,
			status: "protocol_error",
			verified: false,
			verificationOutcome: "infra_error",
			failureCategory: "protocol_error",
		});
	});

	it("classifies socket refusal, timeout, and abort without retrying", async () => {
		await expect(
			new FlagOracleClient({ CTF_ORACLE_SOCKET: join(tmpdir(), `missing-${randomUUID()}.sock`) }).verify({
				flag: "flag{x}",
				challengeId: "target",
			}),
		).rejects.toBeInstanceOf(FlagOracleUnavailableError);

		const timeoutSocket = await listenVerifierSocket(() => undefined);
		await expect(
			new FlagOracleClient({ CTF_ORACLE_SOCKET: timeoutSocket, CTF_ORACLE_TIMEOUT: "0.02" }).verify({
				flag: "flag{x}",
				challengeId: "target",
			}),
		).rejects.toBeInstanceOf(FlagOracleTimeoutError);

		const abortSocket = await listenVerifierSocket(() => undefined);
		const controller = new AbortController();
		const pending = new FlagOracleClient({ CTF_ORACLE_SOCKET: abortSocket }).verify(
			{ flag: "flag{x}", challengeId: "target" },
			controller.signal,
		);
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(FlagOracleAbortedError);
	});
});
