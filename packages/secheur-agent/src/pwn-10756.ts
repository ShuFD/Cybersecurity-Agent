import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, relative, resolve } from "node:path";
import type { ShellProof } from "./bigmodel-runner.ts";

export interface ShellProofVerifierOptions {
	workdir: string;
	nonce?: string;
	proofMarker?: string;
	timeoutMs?: number;
}

export interface ShellProofEndpoint {
	host: "127.0.0.1";
	port: number;
	nonce: string;
}

function ensure10756(workdir: string): string {
	const resolved = resolve(workdir);
	if (basename(resolved) !== "10756" || !existsSync(resolved) || !statSync(resolved).isDirectory())
		throw new Error("Local PWN verifier is restricted to the 10756 workdir");
	return realpathSync(resolved);
}

export class ShellProofVerifier {
	readonly workdir: string;
	readonly nonce: string;
	private readonly proofMarker: string;
	private readonly timeoutMs: number;
	private server?: Server;
	private endpoint?: ShellProofEndpoint;
	private proofPromise?: Promise<ShellProof | undefined>;
	private resolveProof?: (proof: ShellProof | undefined) => void;

	constructor(options: ShellProofVerifierOptions) {
		this.workdir = ensure10756(options.workdir);
		this.nonce = options.nonce ?? randomBytes(12).toString("hex");
		this.proofMarker = options.proofMarker ?? "SECHEUR_SHELL_PROOF";
		this.timeoutMs = Math.max(1_000, Math.trunc(options.timeoutMs ?? 30_000));
	}

	async start(): Promise<ShellProofEndpoint> {
		if (this.endpoint) return this.endpoint;
		const server = createServer((socket) => this.handleConnection(socket));
		this.server = server;
		await new Promise<void>((resolvePromise, rejectPromise) => {
			server.once("error", rejectPromise);
			server.listen(0, "127.0.0.1", () => resolvePromise());
		});
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Shell proof verifier did not receive a TCP address");
		this.endpoint = { host: "127.0.0.1", port: address.port, nonce: this.nonce };
		return this.endpoint;
	}

	waitForProof(): Promise<ShellProof | undefined> {
		if (this.proofPromise) return this.proofPromise;
		this.proofPromise = new Promise<ShellProof | undefined>((resolvePromise) => {
			this.resolveProof = resolvePromise;
			setTimeout(() => {
				if (this.resolveProof === resolvePromise) {
					this.resolveProof = undefined;
					resolvePromise(undefined);
				}
			}, this.timeoutMs).unref();
		});
		return this.proofPromise;
	}

	async close(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.endpoint = undefined;
		if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
	}

	private handleConnection(socket: Socket): void {
		let output = Buffer.alloc(0);
		const finish = (): void => {
			const text = output.toString("utf8");
			const verified = text.includes(this.nonce) && text.includes(this.proofMarker);
			if (!verified || !this.resolveProof) return;
			const proof: ShellProof = {
				nonce: this.nonce,
				command: "nonce-proof",
				output: text.slice(-64 * 1024),
				verified: true,
				createdAt: Date.now(),
			};
			const resolveProof = this.resolveProof;
			this.resolveProof = undefined;
			resolveProof(proof);
		};
		socket.on("data", (chunk: Buffer) => {
			output = Buffer.concat([output, chunk]).subarray(-64 * 1024);
		});
		socket.once("error", () => undefined);
		socket.once("close", finish);
	}
}

export interface LocalPwn10756ServiceOptions {
	workdir: string;
	binary: string;
	args?: string[];
	port?: number;
	loader?: string;
	libc?: string;
}

export class LocalPwn10756Service {
	readonly workdir: string;
	private readonly binary: string;
	private readonly args: string[];
	private readonly port: number;
	private readonly loader?: string;
	private readonly libc?: string;
	private process?: ChildProcess;

	constructor(options: LocalPwn10756ServiceOptions) {
		this.workdir = ensure10756(options.workdir);
		this.binary = this.inside(options.binary);
		this.args = [...(options.args ?? [])];
		this.port =
			Number.isInteger(options.port) && (options.port ?? 0) >= 0 && (options.port ?? 0) <= 65_535
				? (options.port ?? 0)
				: 0;
		this.loader = options.loader ? this.inside(options.loader) : undefined;
		this.libc = options.libc ? this.inside(options.libc) : undefined;
	}

	start(): void {
		if (this.process && !this.process.killed) return;
		const command = this.loader ?? this.binary;
		const args = this.loader ? [this.binary, ...this.args] : [...this.args];
		const childEnv = { ...process.env };
		delete childEnv.BIGMODEL_API_KEY;
		if (this.libc) childEnv.LD_PRELOAD = this.libc;
		else delete childEnv.LD_PRELOAD;
		childEnv.CTF_PORT = String(this.port);
		childEnv.CTF_HOST = "127.0.0.1";
		this.process = spawn(command, args, {
			cwd: this.workdir,
			stdio: "ignore",
			env: childEnv,
		});
	}

	stop(): void {
		this.process?.kill("SIGTERM");
		this.process = undefined;
	}

	private inside(value: string): string {
		const root = realpathSync(this.workdir);
		const resolved = resolve(this.workdir, value);
		const target = realpathSync(resolved);
		const relativePath = relative(root, target);
		if (relativePath.startsWith("..") || relativePath.includes(".."))
			throw new Error("10756 service path escapes the challenge workdir");
		return target;
	}
}
