import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
	DEFAULT_MAX_FRAME_LENGTH,
	decodeCbor,
	encodeCbor,
	encodeFrame,
	FrameDecoder,
} from "@earendil-works/pi-protocol";
import type { CompetitionBroker } from "./competition-broker.ts";
import {
	COMPETITION_PROTOCOL,
	COMPETITION_PROTOCOL_VERSION,
	type CompetitionCommandRequest,
	CompetitionProtocolError,
	type CompetitionRpcRequest,
	type CompetitionRpcResponse,
	parseCompetitionRpcRequest,
} from "./competition-protocol.ts";

export interface CompetitionBrokerServerOptions {
	broker: CompetitionBroker;
	socketPath: string;
	maxFrameLength?: number;
}

function responseFor(requestId: string, error: unknown): CompetitionRpcResponse {
	return {
		protocol: COMPETITION_PROTOCOL,
		version: COMPETITION_PROTOCOL_VERSION,
		requestId,
		ok: false,
		error: {
			code: error instanceof CompetitionProtocolError ? error.code : "invalid_request",
			message: error instanceof Error ? error.message : String(error),
		},
	};
}

function requestIdFromUnknown(value: unknown): string {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const requestId = (value as Record<string, unknown>).requestId;
		if (typeof requestId === "string") return requestId;
	}
	return "unknown";
}

function validateResponse(value: unknown): CompetitionRpcResponse {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Competition broker returned a non-object response");
	const record = value as Record<string, unknown>;
	if (
		record.protocol !== COMPETITION_PROTOCOL ||
		record.version !== COMPETITION_PROTOCOL_VERSION ||
		typeof record.requestId !== "string" ||
		typeof record.ok !== "boolean"
	) {
		throw new Error("Competition broker returned an invalid response");
	}
	return record as unknown as CompetitionRpcResponse;
}

async function writeFrame(socket: Socket, value: unknown, maxFrameLength: number): Promise<void> {
	const frame = encodeFrame(encodeCbor(value, { maxByteLength: maxFrameLength }));
	if (!socket.write(frame))
		await new Promise<void>((resolve, reject) => {
			const onDrain = (): void => {
				cleanup();
				resolve();
			};
			const onClose = (): void => {
				cleanup();
				reject(new Error("Competition broker socket closed during write"));
			};
			const cleanup = (): void => {
				socket.off("drain", onDrain);
				socket.off("close", onClose);
			};
			socket.once("drain", onDrain);
			socket.once("close", onClose);
		});
}

export class CompetitionBrokerServer {
	readonly socketPath: string;
	private readonly broker: CompetitionBroker;
	private readonly maxFrameLength: number;
	private server?: Server;
	private readonly sockets = new Set<Socket>();

	constructor(options: CompetitionBrokerServerOptions) {
		this.socketPath = options.socketPath;
		this.broker = options.broker;
		this.maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
	}

	async start(): Promise<void> {
		if (this.server) return;
		mkdirSync(dirname(this.socketPath), { recursive: true });
		if (existsSync(this.socketPath)) {
			try {
				const stat = lstatSync(this.socketPath);
				if (!stat.isSocket()) throw new Error(`Competition socket path is not a socket: ${this.socketPath}`);
				await new Promise<void>((resolve, reject) => {
					const probe = createConnection(this.socketPath);
					probe.once("connect", () => {
						probe.destroy();
						reject(new Error(`Competition broker is already running: ${this.socketPath}`));
					});
					probe.once("error", () => {
						probe.destroy();
						resolve();
					});
				});
				unlinkSync(this.socketPath);
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("Competition broker is already running"))
					throw error;
				if (error instanceof Error && error.message.startsWith("Competition socket path is not a socket"))
					throw error;
				try {
					unlinkSync(this.socketPath);
				} catch {
					/* The listener may have disappeared. */
				}
			}
		}
		const server = createServer((socket) => this.handleConnection(socket));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = (): void => {
				server.off("error", onError);
				try {
					chmodSync(this.socketPath, 0o660);
					resolve();
				} catch (error) {
					server.close(() => reject(error instanceof Error ? error : new Error(String(error))));
				}
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(this.socketPath);
		});
	}

	private handleConnection(socket: Socket): void {
		this.sockets.add(socket);
		const decoder = new FrameDecoder({ maxFrameLength: this.maxFrameLength });
		let hello = false;
		let closed = false;
		let writeTail = Promise.resolve();
		const send = (value: unknown): Promise<void> => {
			const operation = writeTail.then(() => writeFrame(socket, value, this.maxFrameLength));
			writeTail = operation.catch(() => undefined);
			return operation;
		};
		const sendError = (requestId: string, error: unknown): void => {
			void send(responseFor(requestId, error)).catch(() => socket.destroy());
		};
		socket.on("data", (chunk) => {
			if (closed) return;
			try {
				for (const payload of decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
					const value = decodeCbor(payload, { maxByteLength: this.maxFrameLength });
					let request: CompetitionRpcRequest;
					try {
						request = parseCompetitionRpcRequest(value);
					} catch (error) {
						sendError(requestIdFromUnknown(value), error);
						continue;
					}
					if (request.type === "hello") {
						hello = true;
						void this.broker
							.handleRequest(request)
							.then(send)
							.catch((error) => sendError(request.requestId, error));
						continue;
					}
					if (!hello) {
						sendError(
							request.requestId,
							new CompetitionProtocolError("hello is required before commands", "handshake_required"),
						);
						continue;
					}
					void this.broker
						.handleRequest(request)
						.then(send)
						.catch((error) => sendError(request.requestId, error));
				}
			} catch (error) {
				closed = true;
				sendError("unknown", error);
				socket.destroy();
			}
		});
		socket.once("close", () => {
			closed = true;
			this.sockets.delete(socket);
		});
		socket.once("error", () => {
			closed = true;
		});
	}

	async close(): Promise<void> {
		const server = this.server;
		if (!server) return;
		this.server = undefined;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		try {
			unlinkSync(this.socketPath);
		} catch {
			/* The socket was already removed. */
		}
	}
}

export interface CompetitionBrokerClientOptions {
	socketPath: string;
	clientId?: string;
	maxFrameLength?: number;
	requestTimeoutMs?: number;
}

export class CompetitionBrokerClient {
	private readonly socketPath: string;
	private readonly clientId: string;
	private readonly maxFrameLength: number;
	private readonly requestTimeoutMs: number;
	private socket?: Socket;
	private decoder?: FrameDecoder;
	private readonly pending = new Map<
		string,
		{
			resolve: (response: CompetitionRpcResponse) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	private connectPromise?: Promise<void>;

	constructor(options: CompetitionBrokerClientOptions) {
		this.socketPath = options.socketPath;
		this.clientId = options.clientId ?? `${process.pid}:${Math.random().toString(16).slice(2)}`;
		this.maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
		this.requestTimeoutMs = Math.max(1_000, Math.trunc(options.requestTimeoutMs ?? 15_000));
	}

	async connect(): Promise<void> {
		if (this.connectPromise) return this.connectPromise;
		// `createConnection()` assigns `socket` before the TCP connect and broker
		// hello handshake complete. Concurrent requests must wait for that promise;
		// otherwise a command can arrive before the server has accepted hello.
		if (this.socket && !this.socket.destroyed) return;
		this.connectPromise = new Promise<void>((resolve, reject) => {
			const socket = createConnection(this.socketPath);
			this.socket = socket;
			this.decoder = new FrameDecoder({ maxFrameLength: this.maxFrameLength });
			const fail = (error: Error): void => {
				if (this.socket === socket) this.socket = undefined;
				for (const pending of this.pending.values()) {
					clearTimeout(pending.timer);
					pending.reject(error);
				}
				this.pending.clear();
				reject(error);
			};
			socket.once("connect", () => {
				const requestId = randomRequestId();
				const helloResponse = new Promise<CompetitionRpcResponse>((resolveHello, rejectHello) => {
					const timer = setTimeout(() => {
						this.pending.delete(requestId);
						rejectHello(new Error(`Competition broker handshake timed out after ${this.requestTimeoutMs}ms`));
					}, this.requestTimeoutMs);
					this.pending.set(requestId, { resolve: resolveHello, reject: rejectHello, timer });
				});
				void this.send({
					protocol: COMPETITION_PROTOCOL,
					version: COMPETITION_PROTOCOL_VERSION,
					type: "hello",
					requestId,
					clientId: this.clientId,
				})
					.then(() => helloResponse)
					.then((response) => {
						if (!response.ok) throw new Error(response.error?.message ?? "Competition broker handshake failed");
						resolve();
					})
					.catch(fail);
			});
			socket.on("data", (chunk) => {
				try {
					for (const payload of this.decoder?.push(
						new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
					) ?? []) {
						const response = validateResponse(decodeCbor(payload, { maxByteLength: this.maxFrameLength }));
						const pending = this.pending.get(response.requestId);
						if (!pending) continue;
						this.pending.delete(response.requestId);
						clearTimeout(pending.timer);
						if (response.ok) pending.resolve(response);
						else pending.reject(new Error(response.error?.message ?? "Competition broker command failed"));
					}
				} catch (error) {
					fail(error instanceof Error ? error : new Error(String(error)));
					socket.destroy();
				}
			});
			socket.once("error", fail);
			socket.once("close", () => {
				if (this.socket === socket) this.socket = undefined;
				const error = new Error("Competition broker connection closed");
				for (const pending of this.pending.values()) {
					clearTimeout(pending.timer);
					pending.reject(error);
				}
				this.pending.clear();
			});
		});
		try {
			await this.connectPromise;
		} finally {
			this.connectPromise = undefined;
		}
	}

	private async send(request: CompetitionRpcRequest): Promise<void> {
		const socket = this.socket;
		if (!socket || socket.destroyed) throw new Error("Competition broker client is not connected");
		const frame = encodeFrame(encodeCbor(request, { maxByteLength: this.maxFrameLength }));
		if (!socket.write(frame))
			await new Promise<void>((resolve, reject) => {
				socket.once("drain", resolve);
				socket.once("error", reject);
			});
	}

	async request(
		operation: CompetitionCommandRequest["operation"],
		payload: Record<string, unknown> = {},
	): Promise<unknown> {
		await this.connect();
		const requestId = randomRequestId();
		const request: CompetitionCommandRequest = {
			protocol: COMPETITION_PROTOCOL,
			version: COMPETITION_PROTOCOL_VERSION,
			type: "command",
			requestId,
			operation,
			payload,
		};
		const response = new Promise<CompetitionRpcResponse>((resolve, reject) =>
			this.pending.set(requestId, {
				resolve,
				reject,
				timer: setTimeout(() => {
					this.pending.delete(requestId);
					reject(new Error(`Competition broker request timed out after ${this.requestTimeoutMs}ms`));
				}, this.requestTimeoutMs),
			}),
		);
		try {
			await this.send(request);
		} catch (error) {
			this.pending.delete(requestId);
			throw error;
		}
		const resolved = await response;
		return resolved.result;
	}

	async reconnect(): Promise<void> {
		this.close();
		await this.connect();
	}

	close(): void {
		const socket = this.socket;
		this.socket = undefined;
		if (socket) socket.destroy();
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Competition broker client closed"));
		}
		this.pending.clear();
	}
}

function randomRequestId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
