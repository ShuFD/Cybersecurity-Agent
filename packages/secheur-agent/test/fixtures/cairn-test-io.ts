import { readFile, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
/** Portable equivalents of Bun test IO; assertions and fixtures are unchanged. */
export const cairnTestIO = {
	sleep: setTimeout,
	write: writeFile,
	file(path: string) {
		return {
			text: () => readFile(path, "utf8"),
			arrayBuffer: async () => new Uint8Array(await readFile(path)).buffer,
		};
	},
};
