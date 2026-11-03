import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import { RepoAuditError } from "./errors.ts";

export interface RepoAuditLockMetadata {
	ownerToken: string;
	pid: number;
	hostname: string;
	runId: string;
	createdAt: string;
	heartbeatAt: string;
}

export interface RepoAuditFileLockOptions {
	directory: string;
	runId: string;
	waitTimeoutMs: number;
	staleMs: number;
	heartbeatMs: number;
	signal?: AbortSignal;
	pollMs?: number;
	now?: () => number;
}

export interface RepoAuditFileLock {
	path: string;
	metadata: RepoAuditLockMetadata;
	readonly signal: AbortSignal;
	readonly leaseError: RepoAuditError | null;
	assertOwned(): void;
	release(): Promise<void>;
}

function parseMetadata(text: string): RepoAuditLockMetadata | null {
	try {
		const value = JSON.parse(text) as Partial<RepoAuditLockMetadata>;
		if (
			typeof value.ownerToken !== "string" ||
			typeof value.pid !== "number" ||
			typeof value.hostname !== "string" ||
			typeof value.runId !== "string" ||
			typeof value.createdAt !== "string" ||
			typeof value.heartbeatAt !== "string"
		)
			return null;
		return value as RepoAuditLockMetadata;
	} catch {
		return null;
	}
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function abortError(): RepoAuditError {
	return new RepoAuditError("USER_ABORTED", "RepoAudit lock wait was cancelled.");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(abortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function readMetadata(lockPath: string): Promise<RepoAuditLockMetadata | null> {
	try {
		return parseMetadata(await readFile(lockPath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function recoverStaleLock(lockPath: string, staleMs: number, now: number): Promise<boolean> {
	let metadata: RepoAuditLockMetadata | null;
	let modifiedAt: number;
	try {
		const [text, fileStat] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
		metadata = parseMetadata(text);
		modifiedAt = fileStat.mtimeMs;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		return false;
	}
	const heartbeatAt = metadata === null ? modifiedAt : Date.parse(metadata.heartbeatAt);
	if (!Number.isFinite(heartbeatAt) || now - heartbeatAt < staleMs) return false;
	// A corrupt lock or a lock from another hostname cannot be proven dead. The
	// supported automatic recovery path is a valid same-host lock whose PID no
	// longer exists; distributed leases require a central coordinator.
	if (metadata === null || metadata.hostname !== hostname() || isProcessAlive(metadata.pid)) return false;

	try {
		const latestText = await readFile(lockPath, "utf8");
		const latest = parseMetadata(latestText);
		if (latest?.ownerToken !== metadata.ownerToken || latest.heartbeatAt !== metadata.heartbeatAt) return false;
		const quarantine = `${lockPath}.stale-${randomUUID()}`;
		await rename(lockPath, quarantine);
		await unlink(quarantine).catch(() => undefined);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

async function updateHeartbeat(lockPath: string, ownerToken: string, now: number): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(lockPath, "r+");
		const metadata = parseMetadata(await handle.readFile("utf8"));
		if (metadata === null) {
			throw new RepoAuditError("LOCK_LEASE_LOST", "RepoAudit lock metadata became unreadable during heartbeat.");
		}
		if (metadata.ownerToken !== ownerToken) {
			throw new RepoAuditError("LOCK_LEASE_LOST", "RepoAudit lock owner changed during heartbeat.");
		}
		metadata.heartbeatAt = new Date(now).toISOString();
		const buffer = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
		await handle.truncate(0);
		await handle.write(buffer, 0, buffer.length, 0);
		await handle.sync();
	} finally {
		await handle?.close();
	}
	const current = await readMetadata(lockPath);
	if (current?.ownerToken !== ownerToken) {
		throw new RepoAuditError("LOCK_LEASE_LOST", "RepoAudit lock disappeared or was replaced during heartbeat.");
	}
}

function normalizeLeaseError(error: unknown): RepoAuditError {
	if (error instanceof RepoAuditError && error.code === "LOCK_LEASE_LOST") return error;
	return new RepoAuditError(
		"LOCK_LEASE_LOST",
		"RepoAudit lock heartbeat failed; exclusive ownership can no longer be guaranteed.",
		{ cause: error },
	);
}

export async function acquireRepoAuditFileLock(options: RepoAuditFileLockOptions): Promise<RepoAuditFileLock> {
	await mkdir(options.directory, { recursive: true });
	const lockPath = path.join(options.directory, "repoaudit-scan.lock");
	const ownerToken = randomUUID();
	const now = options.now ?? Date.now;
	const startedAt = now();
	const pollMs = options.pollMs ?? 250;

	while (true) {
		if (options.signal?.aborted) throw abortError();
		const timestamp = new Date(now()).toISOString();
		const metadata: RepoAuditLockMetadata = {
			ownerToken,
			pid: process.pid,
			hostname: hostname(),
			runId: options.runId,
			createdAt: timestamp,
			heartbeatAt: timestamp,
		};
		try {
			const handle = await open(lockPath, "wx");
			try {
				await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			let released = false;
			let heartbeatUpdate = Promise.resolve();
			let leaseError: RepoAuditError | null = null;
			const leaseController = new AbortController();
			const heartbeatIntervalMs = Math.min(options.heartbeatMs, Math.max(10, Math.floor(options.staleMs / 3)));
			const timer = setInterval(() => {
				if (leaseError !== null || released) return;
				heartbeatUpdate = heartbeatUpdate
					.then(() => updateHeartbeat(lockPath, ownerToken, now()))
					.catch((error: unknown) => {
						leaseError = normalizeLeaseError(error);
						clearInterval(timer);
						leaseController.abort(leaseError);
					});
			}, heartbeatIntervalMs);
			timer.unref?.();
			return {
				path: lockPath,
				metadata,
				signal: leaseController.signal,
				get leaseError() {
					return leaseError;
				},
				assertOwned() {
					if (leaseError !== null) throw leaseError;
				},
				async release() {
					if (released) return;
					released = true;
					clearInterval(timer);
					await heartbeatUpdate;
					const current = await readMetadata(lockPath);
					if (current?.ownerToken !== ownerToken) return;
					await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error;
					});
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (await recoverStaleLock(lockPath, options.staleMs, now())) continue;
		if (now() - startedAt >= options.waitTimeoutMs) {
			throw new RepoAuditError("LOCK_TIMEOUT", "Timed out waiting for the RepoAudit cross-process lock.");
		}
		await delay(Math.min(pollMs, Math.max(1, options.waitTimeoutMs - (now() - startedAt))), options.signal);
	}
}
