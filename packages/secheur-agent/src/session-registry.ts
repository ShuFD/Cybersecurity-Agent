import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export type PiSessionRole = "main" | "solver";
export type PiSessionStatus = "starting" | "idle" | "running" | "stopped" | "error";

const MAX_UNIX_SOCKET_PATH_BYTES = process.platform === "linux" ? 107 : 103;
const SESSION_SOCKET_HASH_LENGTH = 20;
const FALLBACK_SOCKET_HASH_LENGTH = 12;
const FALLBACK_SOCKET_ROOT = "secheur-agent-sockets";

export interface PiSessionRegistration {
	sessionId: string;
	role: PiSessionRole;
	title: string;
	socketPath: string;
	pid: number;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	status: PiSessionStatus;
	taskId?: string;
	category?: string;
	parentMainSessionId?: string;
	tmuxTarget?: string;
	mainSessionId?: string;
	/** Names of tools registered by the owning Pi session. */
	tools?: string[];
	/** Names of tools currently enabled by the owning Pi session. */
	activeTools?: string[];
	/** Explicit attack knowledge-base state owned by the runtime. */
	knowledgeBaseEnabled?: boolean;
}

export function sessionRegistryDirectory(stateDir: string): string {
	return join(stateDir, "sessions");
}

/**
 * Derive a Unix socket path that remains below the platform's sockaddr limit.
 * The fallback includes a digest of the state root so separate installations
 * cannot accidentally share the same socket filename.
 */
export function stateSocketPath(stateDir: string, fileName: string, fallbackFileName = fileName): string {
	const stateRoot = resolve(stateDir);
	const relativePath = fileName.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "") || "socket.sock";
	const statePath = join(stateRoot, relativePath);
	// PiServer adds a private bind name beside the public socket. Leave one byte of
	// headroom so a path at the platform limit does not fail during listener setup.
	if (Buffer.byteLength(statePath) < MAX_UNIX_SOCKET_PATH_BYTES) return statePath;

	const stateDigest = createHash("sha256").update(stateRoot).digest("hex").slice(0, 16);
	const fallbackName = basename(fallbackFileName.replaceAll("\\", "/")) || "socket.sock";
	const temporaryPath = join(tmpdir(), FALLBACK_SOCKET_ROOT, stateDigest, fallbackName);
	if (Buffer.byteLength(temporaryPath) < MAX_UNIX_SOCKET_PATH_BYTES) return temporaryPath;
	// A custom TMPDIR can itself be deeply nested. POSIX systems always provide
	// /tmp, which keeps the derived basename stable for bridge fallback discovery.
	if (process.platform !== "win32") {
		const portablePath = join("/tmp", FALLBACK_SOCKET_ROOT, stateDigest, fallbackName);
		if (Buffer.byteLength(portablePath) < MAX_UNIX_SOCKET_PATH_BYTES) return portablePath;
	}
	throw new Error("Cannot derive a Unix session socket path within the platform limit");
}

export function sessionSocketPath(stateDir: string, sessionId: string): string {
	const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, SESSION_SOCKET_HASH_LENGTH);
	return stateSocketPath(
		stateDir,
		join("s", `${digest}.sock`),
		`${digest.slice(0, FALLBACK_SOCKET_HASH_LENGTH)}.sock`,
	);
}

export function competitionSocketPath(stateDir: string): string {
	return stateSocketPath(stateDir, "competition.sock");
}

function registrationPath(stateDir: string, sessionId: string): string {
	return join(sessionRegistryDirectory(stateDir), `${encodeURIComponent(sessionId)}.json`);
}

function isRegistration(value: unknown): value is PiSessionRegistration {
	if (typeof value !== "object" || value === null) return false;
	const item = value as Record<string, unknown>;
	const optionalStringArray = (candidate: unknown): boolean =>
		candidate === undefined || (Array.isArray(candidate) && candidate.every((entry) => typeof entry === "string"));
	return (
		typeof item.sessionId === "string" &&
		(item.role === "main" || item.role === "solver") &&
		typeof item.title === "string" &&
		typeof item.socketPath === "string" &&
		typeof item.pid === "number" &&
		typeof item.cwd === "string" &&
		typeof item.createdAt === "number" &&
		typeof item.updatedAt === "number" &&
		(item.status === "starting" ||
			item.status === "idle" ||
			item.status === "running" ||
			item.status === "stopped" ||
			item.status === "error") &&
		optionalStringArray(item.tools) &&
		optionalStringArray(item.activeTools) &&
		(item.knowledgeBaseEnabled === undefined || typeof item.knowledgeBaseEnabled === "boolean")
	);
}

async function isProcessAlive(pid: number): Promise<boolean> {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

export async function writeSessionRegistrationAt(stateDir: string, registration: PiSessionRegistration): Promise<void> {
	const directory = sessionRegistryDirectory(stateDir);
	await mkdir(directory, { recursive: true, mode: 0o2770 });
	const target = registrationPath(stateDir, registration.sessionId);
	const temporary = `${target}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(registration)}\n`, { mode: 0o660 });
	await chmod(temporary, 0o660);
	await rename(temporary, target);
}

export async function removeSessionRegistration(stateDir: string, sessionId: string): Promise<void> {
	try {
		await unlink(registrationPath(stateDir, sessionId));
	} catch (error) {
		if (!isErrorCode(error, "ENOENT")) throw error;
	}
}

export async function listSessionRegistrations(
	stateDir: string,
	options: { pruneStale?: boolean; verifyProcess?: boolean } = {},
): Promise<PiSessionRegistration[]> {
	const directory = sessionRegistryDirectory(stateDir);
	let files: string[];
	try {
		files = await readdir(directory);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return [];
		throw error;
	}

	const registrations: PiSessionRegistration[] = [];
	for (const file of files.filter((name) => name.endsWith(".json"))) {
		const path = join(directory, file);
		try {
			const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
			if (!isRegistration(parsed)) {
				if (options.pruneStale) await unlink(path);
				continue;
			}
			if (options.pruneStale && options.verifyProcess !== false && !(await isProcessAlive(parsed.pid))) {
				try {
					await unlink(path);
				} catch (error) {
					if (!isErrorCode(error, "ENOENT") && !isErrorCode(error, "EACCES") && !isErrorCode(error, "EPERM"))
						throw error;
				}
				continue;
			}
			registrations.push(parsed);
		} catch (error) {
			if (options.pruneStale && isErrorCode(error, "ENOENT")) continue;
			if (options.pruneStale) {
				try {
					await unlink(path);
				} catch (unlinkError) {
					if (!isErrorCode(unlinkError, "ENOENT")) throw unlinkError;
				}
				continue;
			}
			throw error;
		}
	}
	return registrations.sort((left, right) => left.createdAt - right.createdAt);
}

function isErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
