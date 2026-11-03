import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

export const MAX_EVIDENCE_BLOB_BYTES = 8 * 1024 * 1024;
export const MAX_EVIDENCE_READ_BYTES = 64 * 1024;

const SECRET_KEY = /token|password|secret|authorization|cookie|api[-_]?key/i;
const TOKEN_USAGE_KEY = /^(inputTokens|outputTokens|totalTokens|cacheReadTokens|cacheWriteTokens)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (depth > 8) return "[depth limit]";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
		return value;
	}
	if (typeof value === "undefined") return null;
	if (typeof value !== "object") return String(value);
	if (seen.has(value)) return "[circular value]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));
	const output: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		output[key] =
			SECRET_KEY.test(key) && !(TOKEN_USAGE_KEY.test(key) && typeof item === "number")
				? "[REDACTED]"
				: redact(item, depth + 1, seen);
	}
	return output;
}

function serialize(value: unknown): string {
	try {
		const result = JSON.stringify(value);
		return typeof result === "string" ? result : JSON.stringify(String(value));
	} catch {
		return JSON.stringify({ unserializable: String(value) });
	}
}

function hashText(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function sliceUtf8(value: string, maximumBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maximumBytes) return value;
	const headBytes = Math.max(1, Math.floor(maximumBytes / 2));
	const tailBytes = Math.max(1, maximumBytes - headBytes);
	return `${bytes.subarray(0, headBytes).toString("utf8")}\n...[content truncated; use planning_read_evidence]...\n${bytes
		.subarray(bytes.length - tailBytes)
		.toString("utf8")}`;
}

function safeRelativeRef(stateDir: string, contentRef: string): string {
	if (typeof contentRef !== "string" || !contentRef.startsWith("planning-evidence/")) {
		throw new Error("invalid evidence content reference");
	}
	const root = resolve(stateDir, "planning-evidence");
	const candidate = resolve(stateDir, contentRef);
	const rel = relative(root, candidate);
	if (rel.startsWith(`..${sep}`) || rel === ".." || rel.includes(`${sep}..${sep}`)) {
		throw new Error("evidence content reference escapes state directory");
	}
	return candidate;
}

export function makeEvidenceExcerpt(value: unknown, maximumBytes = 4_096): string {
	return sliceUtf8(serialize(redact(value)), maximumBytes);
}

export function makeEvidenceLocator(execution: { toolName?: string; toolInput?: unknown }): Record<string, unknown> {
	const input = isRecord(execution.toolInput) ? (redact(execution.toolInput) as Record<string, unknown>) : undefined;
	const path = input?.path ?? input?.filePath ?? input?.filename;
	const command = input?.command ?? input?.cmd;
	const url = input?.url;
	if (typeof path === "string" && path.length > 0) return { type: "file", toolName: execution.toolName, path };
	if (typeof command === "string" && command.length > 0) {
		return { type: "command", toolName: execution.toolName, command, cwd: input?.cwd };
	}
	if (typeof url === "string" && url.length > 0) {
		return { type: "http", toolName: execution.toolName, url, method: input?.method };
	}
	return { type: "tool", toolName: execution.toolName };
}

export interface CapturedEvidenceBlob {
	contentRef: string | null;
	contentHash: string;
	contentBytes: number;
	contentComplete: boolean;
}

export function captureEvidenceBlob(input: {
	stateDir?: string;
	runId: string;
	evidenceId: string;
	toolCallId: string;
	toolName: string;
	toolInput?: unknown;
	result: unknown;
	isError: boolean;
}): CapturedEvidenceBlob {
	const payload = {
		// The blob address must be stable for a repeated completion callback.
		// Old version-1 blobs (which included capturedAt) remain readable by hash.
		schemaVersion: 2,
		evidenceId: input.evidenceId,
		runId: input.runId,
		toolCallId: input.toolCallId,
		toolName: input.toolName,
		input: redact(input.toolInput),
		result: redact(input.result),
		isError: input.isError === true,
	};
	const serialized = serialize(payload);
	const originalBytes = Buffer.byteLength(serialized, "utf8");
	const storedText =
		originalBytes <= MAX_EVIDENCE_BLOB_BYTES
			? serialized
			: JSON.stringify({
					schemaVersion: 2,
					evidenceId: input.evidenceId,
					runId: input.runId,
					toolCallId: input.toolCallId,
					toolName: input.toolName,
					truncated: true,
					originalBytes,
					head: Buffer.from(serialized, "utf8")
						.subarray(0, Math.floor(MAX_EVIDENCE_BLOB_BYTES / 2))
						.toString("utf8"),
					tail: Buffer.from(serialized, "utf8")
						.subarray(-Math.floor(MAX_EVIDENCE_BLOB_BYTES / 2))
						.toString("utf8"),
				});
	const contentHash = hashText(storedText);
	const contentBytes = Buffer.byteLength(storedText, "utf8");
	if (!input.stateDir || input.stateDir === ":memory:") {
		return { contentRef: null, contentHash, contentBytes, contentComplete: originalBytes <= MAX_EVIDENCE_BLOB_BYTES };
	}
	const contentRef = `planning-evidence/blobs/sha256/${contentHash.slice(0, 2)}/${contentHash}.json`;
	const absolutePath = safeRelativeRef(input.stateDir, contentRef);
	mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
	if (!existsSync(absolutePath)) {
		const temporaryPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(temporaryPath, storedText, { encoding: "utf8", mode: 0o600 });
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, absolutePath);
	}
	return { contentRef, contentHash, contentBytes, contentComplete: originalBytes <= MAX_EVIDENCE_BLOB_BYTES };
}

export interface EvidenceBlobChunk {
	contentRef: string;
	contentHash: string;
	offset: number;
	nextOffset: number;
	totalBytes: number;
	hasMore: boolean;
	content: string;
	contentComplete: true;
}

export function readEvidenceBlob(input: {
	stateDir?: string;
	contentRef: string;
	contentHash?: string;
	offset?: number;
	maxBytes?: number;
}): EvidenceBlobChunk {
	if (!input.stateDir || input.stateDir === ":memory:") throw new Error("evidence blob storage is unavailable");
	const safeOffset = Number.isFinite(input.offset) ? Math.max(0, Math.trunc(input.offset as number)) : 0;
	const safeMaxBytes = Number.isFinite(input.maxBytes)
		? Math.min(MAX_EVIDENCE_READ_BYTES, Math.max(256, Math.trunc(input.maxBytes as number)))
		: MAX_EVIDENCE_READ_BYTES;
	const absolutePath = safeRelativeRef(input.stateDir, input.contentRef);
	const bytes = readFileSync(absolutePath);
	const actualHash = hashText(bytes);
	if (input.contentHash && actualHash !== input.contentHash) throw new Error("evidence content hash mismatch");
	const chunk = bytes.subarray(safeOffset, safeOffset + safeMaxBytes);
	return {
		contentRef: input.contentRef,
		contentHash: actualHash,
		offset: safeOffset,
		nextOffset: safeOffset + chunk.length,
		totalBytes: bytes.length,
		hasMore: safeOffset + chunk.length < bytes.length,
		content: chunk.toString("utf8"),
		contentComplete: true,
	};
}

export function evidenceBlobStat(input: { stateDir?: string; contentRef: string }): number | null {
	if (!input.stateDir || input.stateDir === ":memory:") return null;
	return statSync(safeRelativeRef(input.stateDir, input.contentRef)).size;
}

/** Host-only exact decoding for source bindings; avoid splitting UTF-8 across paged reads. */
export function readCompleteEvidenceBlob(input: {
	stateDir: string;
	contentRef: string;
	contentHash: string;
	runId: string;
	evidenceId: string;
	allowIncomplete?: boolean;
}): Record<string, unknown> {
	const bytes = readFileSync(safeRelativeRef(input.stateDir, input.contentRef));
	if ((!input.allowIncomplete && bytes.length > MAX_EVIDENCE_BLOB_BYTES) || hashText(bytes) !== input.contentHash)
		throw new Error("Original source size or hash mismatch");
	const value: unknown = JSON.parse(bytes.toString("utf8"));
	if (
		!isRecord(value) ||
		value.runId !== input.runId ||
		value.evidenceId !== input.evidenceId ||
		(!input.allowIncomplete && (value.contentComplete === false || value.truncated === true))
	)
		throw new Error("Original source is incomplete or belongs to another run");
	return value;
}
