import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import { parseArgs } from "@earendil-works/pi-coding-agent";

const piEntryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const loaderPath = path.join(path.dirname(piEntryPath), "core", "extensions", "loader.js");
const { loadExtensions } = await import(pathToFileURL(loaderPath).href);

const entryPath = fileURLToPath(new URL("../dist/src/index.js", import.meta.url));
const parsed = parseArgs(["-e", entryPath]);

assert.deepEqual(parsed.extensions, [entryPath]);

const loaded = await loadExtensions(parsed.extensions, process.cwd());
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);

const toolNames = [...loaded.extensions[0].tools.keys()];
assert.deepEqual(toolNames, ["repoaudit_scan"]);

console.log(JSON.stringify({
  extensionPath: entryPath,
  extensionCount: loaded.extensions.length,
  toolNames,
  initializationErrors: loaded.errors,
}));
