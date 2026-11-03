import { statSync } from "node:fs";

/**
 * Which attack-memory files belong in a published release.
 *
 * Retrieval walks the category directories by name (`pwn_v1`, `web_v1`, ...)
 * and reads whichever of these files a directory has, so publishing only some
 * of them leaves the rest of the categories silently returning nothing — which
 * is indistinguishable from an empty knowledge base in the audit log.
 *
 * `stage-legacy.mjs` (what gets copied) and `verify-dist.mjs` (what is allowed
 * to exist afterwards) must agree, so both import this rule instead of keeping
 * their own copy; a divergence here silently blocks or silently ships data.
 */
export const ATTACK_MEMORY_INDEX_ROOT = "memory/attack_memory/";

/** Retrieval inputs shared by every category index. */
export const attackMemoryPublishedFiles = new Set(["manifest.json", "records.jsonl", "embeddings.jsonl"]);

/** Distillation by-products: large, and never read at query time. */
export const attackMemoryExcludedDirectories = new Set(["evidence"]);

/**
 * True when `absolutePath` is a published attack-memory entry.
 *
 * Directories answer true as well: the copy filter runs on directories, and
 * rejecting one prunes its entire subtree.
 */
export function isPublishedAttackMemoryEntry(normalizedRelativePath, absolutePath) {
	if (!normalizedRelativePath.startsWith(ATTACK_MEMORY_INDEX_ROOT)) return false;
	const rest = normalizedRelativePath.slice(ATTACK_MEMORY_INDEX_ROOT.length);
	const separator = rest.lastIndexOf("/");
	const directory = separator === -1 ? "" : rest.slice(0, separator);
	const name = rest.slice(separator + 1);
	if (statSync(absolutePath).isDirectory()) return !attackMemoryExcludedDirectories.has(name);
	if (attackMemoryExcludedDirectories.has(name)) return false;
	// Cards are the crypto retrieval boundary and live under knowledge/.
	if (name === "cards.jsonl") return directory.endsWith("knowledge");
	return attackMemoryPublishedFiles.has(name);
}
