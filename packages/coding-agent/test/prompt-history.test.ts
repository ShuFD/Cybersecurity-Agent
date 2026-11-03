import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROMPT_HISTORY_LIMIT, PromptHistoryStore } from "../src/core/prompt-history.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createStore(): PromptHistoryStore {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-history-test-"));
	roots.push(root);
	return new PromptHistoryStore(join(root, "prompt-history.json"));
}

describe("PromptHistoryStore", () => {
	it("persists history across store instances in newest-first order", () => {
		const store = createStore();
		store.add("first prompt");
		store.add("second prompt");

		expect(new PromptHistoryStore(store.path).load()).toEqual(["second prompt", "first prompt"]);
	});

	it("moves duplicate prompts to the front and bounds the file", () => {
		const store = createStore();
		for (let index = 0; index < PROMPT_HISTORY_LIMIT + 10; index += 1) store.add(`prompt ${index}`);
		store.add("prompt 50");

		const entries = store.load();
		expect(entries).toHaveLength(PROMPT_HISTORY_LIMIT);
		expect(entries[0]).toBe("prompt 50");
		expect(new Set(entries).size).toBe(entries.length);
	});

	it("recovers from a malformed history file on the next submission", () => {
		const store = createStore();
		writeFileSync(store.path, "not json", "utf8");

		expect(store.load()).toEqual([]);
		store.add("recovered prompt");
		expect(store.load()).toEqual(["recovered prompt"]);
	});
});
