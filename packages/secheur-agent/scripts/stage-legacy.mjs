import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ATTACK_MEMORY_INDEX_ROOT, isPublishedAttackMemoryEntry } from "./attack-memory-publish.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(packageRoot, "../../legacy");
const defaultDestinationRoot = join(packageRoot, "dist", "legacy");
const runtimeMarker = ".secheur-runtime.json";

function parseArguments(args) {
	let destinationRoot = defaultDestinationRoot;
	let replace = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--replace") {
			replace = true;
			continue;
		}
		if (argument === "--destination") {
			const destination = args[index + 1];
			if (!destination || destination.startsWith("--")) throw new Error("--destination requires a path");
			destinationRoot = resolve(destination);
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${argument}`);
	}
	return { destinationRoot, replace };
}

function containsPath(parent, child) {
	const childPath = relative(parent, child);
	return childPath === "" || (!childPath.startsWith(`..${sep}`) && childPath !== ".." && !isAbsolute(childPath));
}

const { destinationRoot, replace } = parseArguments(process.argv.slice(2));

if (!existsSync(join(sourceRoot, "secheur_pi_bridge.py"))) {
	throw new Error(`Legacy runtime source is missing: ${sourceRoot}`);
}
if (containsPath(sourceRoot, destinationRoot)) {
	throw new Error(`Refusing to stage legacy runtime inside its source: ${destinationRoot}`);
}
if (containsPath(destinationRoot, packageRoot) || containsPath(destinationRoot, sourceRoot)) {
	throw new Error(`Refusing to replace a directory that contains source files: ${destinationRoot}`);
}
if (existsSync(destinationRoot)) {
	if (!replace) throw new Error(`Legacy staging destination already exists: ${destinationRoot}`);
	if (destinationRoot !== defaultDestinationRoot && !existsSync(join(destinationRoot, runtimeMarker))) {
		throw new Error(`Refusing to replace an unmarked legacy staging destination: ${destinationRoot}`);
	}
}

const excludedDirectories = new Set([
	".git",
	".github",
	".pytest_cache",
	".secheur-agent",
	".venv",
	"__pycache__",
	"node_modules",
	"target",
	"tasks",
	"temp",
	"tests",
	"venv",
]);
const excludedPrefixes = ["frontends/desktop/src-tauri"];
function shouldCopy(path) {
	const relativePath = relative(sourceRoot, path).split(sep).join("/");
	if (!relativePath) return true;
	if (relativePath.split("/").some((part) => excludedDirectories.has(part))) return false;
	if (excludedPrefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`))) return false;
	if (relativePath.startsWith(ATTACK_MEMORY_INDEX_ROOT)) return isPublishedAttackMemoryEntry(relativePath, path);
	const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
	if ([".DS_Store", ".env", "auth.json", "mykey.py", "mykey.py.bak"].includes(name)) return false;
	return !name.endsWith(".pyc") && !name.endsWith(".pyo") && !name.endsWith(".log");
}

const requiredFiles = [
	"secheur_pi_bridge.py",
	"runtime_session_log.py",
	"ctf_attack_memory/distill.py",
	"assets/tools_schema.json",
	"frontends/desktop/static/index.html",
	"frontends/desktop/static/updates.html",
	"frontends/desktop/static/webui/index.html",
	"frontends/desktop/static/desktop-plugins.js",
	"frontends/desktop/static/trajectory-viewer.css",
	"frontends/desktop/static/trajectory-viewer.js",
	"frontends/desktop/plugins/conversation-trace-ui/package.json",
	"frontends/desktop/plugins/conversation-trace-ui/README.md",
	"ctf-benchmark-dashboard/index.html",
	"ctf-benchmark-dashboard/assets/scoreboard.png",
	"ctf-benchmark-dashboard/assets/forensic-dossier.png",
	"ctf-benchmark-dashboard/assets/challenge-board.png",
	"memory/attack_memory/crypto_v1/knowledge/cards.jsonl",
	"memory/attack_memory/pwn_v2/records.jsonl",
];

/**
 * Fail the build if any category index would ship incomplete.
 *
 * A category missing from the release is indistinguishable at query time from
 * an empty knowledge base, so a partial publish must break the build instead of
 * quietly shrinking the corpus the evaluation measures.
 */
function attackMemoryIndexDirectories() {
	const root = join(sourceRoot, "memory", "attack_memory");
	if (!existsSync(root)) throw new Error(`Attack memory source is missing: ${root}`);
	const directories = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /_v\d+$/u.test(entry.name))
		.map((entry) => entry.name);
	if (directories.length === 0) throw new Error(`No attack memory category index found in ${root}`);
	for (const name of directories) {
		const relativePath = `memory/attack_memory/${name}`;
		const staged = join(stagedRoot, relativePath);
		for (const file of ["manifest.json", "records.jsonl"]) {
			if (!existsSync(join(staged, file))) throw new Error(`Staged ${relativePath} is missing ${file}`);
		}
	}
	return directories;
}

function countFiles(path) {
	let count = 0;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) count += countFiles(child);
		else if (entry.isFile() || statSync(child).isFile()) count += 1;
	}
	return count;
}

mkdirSync(dirname(destinationRoot), { recursive: true });
const temporaryRoot = mkdtempSync(join(dirname(destinationRoot), `.${basename(destinationRoot)}-`));
const stagedRoot = join(temporaryRoot, "payload");
try {
	cpSync(sourceRoot, stagedRoot, { recursive: true, filter: shouldCopy });
	writeFileSync(join(stagedRoot, runtimeMarker), `${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`);
	for (const required of requiredFiles) {
		if (!existsSync(join(stagedRoot, required))) throw new Error(`Staged legacy runtime is incomplete: ${required}`);
	}
	const attackMemoryDirectories = attackMemoryIndexDirectories();
	const fileCount = countFiles(stagedRoot);
	if (existsSync(destinationRoot)) rmSync(destinationRoot, { recursive: true, force: true });
	renameSync(stagedRoot, destinationRoot);
	console.log(
		`Staged ${fileCount} legacy runtime files (${attackMemoryDirectories.length} attack memory indices: ${attackMemoryDirectories.join(", ")}) in ${destinationRoot}`,
	);
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
