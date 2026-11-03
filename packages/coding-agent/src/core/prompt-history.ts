import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";

const PROMPT_HISTORY_VERSION = 1;
export const PROMPT_HISTORY_LIMIT = 100;

interface PromptHistoryFile {
	version: number;
	entries: string[];
}

function normalizeEntries(value: unknown): string[] {
	const entries = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null && "entries" in value
			? (value as { entries?: unknown }).entries
			: [];
	if (!Array.isArray(entries)) return [];
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const text = entry.trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		normalized.push(text);
		if (normalized.length === PROMPT_HISTORY_LIMIT) break;
	}
	return normalized;
}

function parseEntries(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		return normalizeEntries(JSON.parse(raw));
	} catch {
		return [];
	}
}

function serializeEntries(entries: string[]): string {
	const payload: PromptHistoryFile = {
		version: PROMPT_HISTORY_VERSION,
		entries,
	};
	return `${JSON.stringify(payload, null, 2)}\n`;
}

export function getPromptHistoryPath(): string {
	return join(getAgentDir(), "prompt-history.json");
}

export class PromptHistoryStore {
	readonly path: string;

	constructor(path = getPromptHistoryPath()) {
		this.path = path;
	}

	private acquireLock(): () => void {
		return lockfile.lockSync(this.path, { realpath: false });
	}

	load(): string[] {
		if (!existsSync(this.path)) return [];
		const release = this.acquireLock();
		try {
			return parseEntries(readFileSync(this.path, "utf8"));
		} finally {
			release();
		}
	}

	add(text: string): void {
		const entry = text.trim();
		if (!entry) return;
		const directory = dirname(this.path);
		mkdirSync(directory, { recursive: true });
		if (!existsSync(this.path)) {
			try {
				writeFileSync(this.path, serializeEntries([]), { encoding: "utf8", flag: "wx", mode: 0o600 });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: "";
				if (code !== "EEXIST") throw error;
			}
		}
		const release = this.acquireLock();
		try {
			const current = parseEntries(readFileSync(this.path, "utf8"));
			const entries = [entry, ...current.filter((item) => item !== entry)].slice(0, PROMPT_HISTORY_LIMIT);
			writeFileSync(this.path, serializeEntries(entries), "utf8");
		} finally {
			release();
		}
	}
}
