import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	copyFileSync,
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { type ArtifactRef, sha256Text } from "./competition-protocol.ts";
import type { AttachmentCacheEntry, CompetitionStore } from "./competition-store.ts";

export interface AttachmentCacheOptions {
	store: CompetitionStore;
	cacheRoot: string;
	maxBytes?: number;
	maxConcurrent?: number;
	perHostIntervalMs?: number;
	leaseTtlMs?: number;
	retries?: number;
	fetchImpl?: typeof fetch;
}

export class AttachmentDownloadError extends Error {
	readonly status?: number;
	readonly retryAfterMs?: number;

	constructor(message: string, status?: number, retryAfterMs?: number) {
		super(message);
		this.name = "AttachmentDownloadError";
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

class LocalSemaphore {
	private readonly max: number;
	private active = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(max: number) {
		this.max = Math.max(1, Math.trunc(max));
	}

	async acquire(): Promise<() => void> {
		if (this.active < this.max) {
			this.active += 1;
			return () => this.release();
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
		this.active += 1;
		return () => this.release();
	}

	private release(): void {
		this.active = Math.max(0, this.active - 1);
		this.waiters.shift()?.();
	}
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	if (signal?.aborted)
		return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		const abort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function responseRetryAfter(response: Response): number | undefined {
	const value = response.headers.get("retry-after");
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, Math.trunc(seconds * 1000));
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "invalid-url";
	}
}

function cacheKey(ref: ArtifactRef): string {
	return sha256Text(`${ref.url}\n${ref.sha256 ?? ""}\n${ref.sizeBytes ?? ""}`);
}

async function validCachedFile(entry: AttachmentCacheEntry, ref: ArtifactRef): Promise<boolean> {
	if (!existsSync(entry.path)) return false;
	try {
		const stat = statSync(entry.path);
		if (stat.size !== entry.sizeBytes || (ref.sizeBytes !== undefined && stat.size !== ref.sizeBytes)) return false;
		if (ref.sha256 && entry.sha256.toLowerCase() !== ref.sha256.toLowerCase()) return false;
		const digest = createHash("sha256");
		for await (const chunk of createReadStream(entry.path)) digest.update(chunk);
		return digest.digest("hex") === entry.sha256.toLowerCase();
	} catch {
		return false;
	}
}

export class AttachmentCache {
	private readonly store: CompetitionStore;
	private readonly cacheRoot: string;
	private readonly maxBytes: number;
	private readonly maxConcurrent: number;
	private readonly perHostIntervalMs: number;
	private readonly leaseTtlMs: number;
	private readonly retries: number;
	private readonly fetchImpl: typeof fetch;
	private readonly semaphore: LocalSemaphore;

	constructor(options: AttachmentCacheOptions) {
		this.store = options.store;
		this.cacheRoot = options.cacheRoot;
		this.maxBytes = Math.max(1, Math.trunc(options.maxBytes ?? 512 * 1024 * 1024));
		this.maxConcurrent = Math.max(1, Math.trunc(options.maxConcurrent ?? 3));
		this.perHostIntervalMs = Math.max(0, Math.trunc(options.perHostIntervalMs ?? 250));
		this.leaseTtlMs = Math.max(5_000, Math.trunc(options.leaseTtlMs ?? 5 * 60_000));
		this.retries = Math.max(0, Math.trunc(options.retries ?? 3));
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.semaphore = new LocalSemaphore(this.maxConcurrent);
		mkdirSync(this.cacheRoot, { recursive: true });
	}

	async download(ref: ArtifactRef, signal?: AbortSignal): Promise<AttachmentCacheEntry> {
		const key = cacheKey(ref);
		const existing = this.store.getArtifact(key);
		if (existing && (await validCachedFile(existing, ref))) return existing;
		const releaseLocal = await this.semaphore.acquire();
		const ownerId = `${process.pid}:${sha256Text(`${key}:${Date.now()}:${Math.random()}`).slice(0, 12)}`;
		try {
			while (!this.store.tryAcquireArtifactLease(key, ownerId, this.leaseTtlMs, Date.now(), this.maxConcurrent)) {
				await wait(50, signal);
				const cached = this.store.getArtifact(key);
				if (cached && (await validCachedFile(cached, ref))) return cached;
			}
			try {
				const cached = this.store.getArtifact(key);
				if (cached && (await validCachedFile(cached, ref))) return cached;
				return await this.downloadWithRetries(ref, key, signal);
			} finally {
				this.store.releaseArtifactLease(key, ownerId);
			}
		} finally {
			releaseLocal();
		}
	}

	private async downloadWithRetries(
		ref: ArtifactRef,
		key: string,
		signal?: AbortSignal,
	): Promise<AttachmentCacheEntry> {
		let lastError: unknown;
		for (let attempt = 0; attempt <= this.retries; attempt += 1) {
			try {
				return await this.downloadOnce(ref, key, signal);
			} catch (error) {
				lastError = error;
				if (attempt >= this.retries) break;
				const retryAfter = error instanceof AttachmentDownloadError ? error.retryAfterMs : undefined;
				const backoff = retryAfter ?? Math.min(30_000, 250 * 2 ** attempt) + Math.trunc(Math.random() * 250);
				await wait(backoff, signal);
			}
		}
		throw lastError instanceof Error ? lastError : new AttachmentDownloadError(String(lastError));
	}

	private async downloadOnce(ref: ArtifactRef, key: string, signal?: AbortSignal): Promise<AttachmentCacheEntry> {
		const urlHost = hostOf(ref.url);
		const startAt = this.store.reserveHostRate(urlHost, this.perHostIntervalMs);
		await wait(Math.max(0, startAt - Date.now()), signal);
		const response = await this.fetchImpl(ref.url, { signal });
		if (!response.ok)
			throw new AttachmentDownloadError(
				`Attachment download failed: HTTP ${response.status}`,
				response.status,
				responseRetryAfter(response),
			);
		const contentLength = Number(response.headers.get("content-length") ?? 0);
		if (contentLength > this.maxBytes || (ref.sizeBytes !== undefined && contentLength > ref.sizeBytes)) {
			throw new AttachmentDownloadError(`Attachment exceeds configured size limit: ${ref.name}`, response.status);
		}
		const finalPath = join(this.cacheRoot, `${key}.bin`);
		const partialPath = `${finalPath}.${process.pid}.part`;
		let size = 0;
		const digest = createHash("sha256");
		const output = createWriteStream(partialPath, { mode: 0o600 });
		try {
			if (response.body) {
				const reader = response.body.getReader();
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					const bytes = chunk.value;
					size += bytes.byteLength;
					if (size > this.maxBytes || (ref.sizeBytes !== undefined && size > ref.sizeBytes))
						throw new AttachmentDownloadError(`Attachment exceeds configured size limit: ${ref.name}`);
					digest.update(bytes);
					if (!output.write(bytes)) await once(output, "drain");
				}
			} else {
				const bytes = new Uint8Array(await response.arrayBuffer());
				size = bytes.byteLength;
				if (size > this.maxBytes || (ref.sizeBytes !== undefined && size > ref.sizeBytes))
					throw new AttachmentDownloadError(`Attachment exceeds configured size limit: ${ref.name}`);
				digest.update(bytes);
				if (!output.write(bytes)) await once(output, "drain");
			}
			output.end();
			await once(output, "close");
			const sha256 = digest.digest("hex");
			if (ref.sha256 && sha256.toLowerCase() !== ref.sha256.toLowerCase())
				throw new AttachmentDownloadError(`Attachment SHA-256 mismatch: ${ref.name}`);
			if (ref.sizeBytes !== undefined && size !== ref.sizeBytes)
				throw new AttachmentDownloadError(`Attachment size mismatch: ${ref.name}`);
			renameSync(partialPath, finalPath);
			const now = Date.now();
			const entry: AttachmentCacheEntry = {
				cacheKey: key,
				url: ref.url,
				sha256,
				sizeBytes: size,
				path: finalPath,
				createdAt: now,
				lastAccessedAt: now,
			};
			this.store.putArtifact(entry);
			return entry;
		} catch (error) {
			output.destroy();
			try {
				rmSync(partialPath, { force: true });
			} catch {
				// Preserve the original download error.
			}
			throw error;
		}
	}

	async downloadTo(ref: ArtifactRef, targetPath: string, signal?: AbortSignal): Promise<AttachmentCacheEntry> {
		const entry = await this.download(ref, signal);
		mkdirSync(targetPath, { recursive: true });
		const outputPath = join(targetPath, basename(ref.name));
		copyFileSync(entry.path, outputPath);
		return { ...entry, path: outputPath };
	}
}
