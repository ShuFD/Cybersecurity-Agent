import { constants, accessSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ATTACK_MEMORY_INDEX_ROOT,
	isPublishedAttackMemoryEntry,
} from "./attack-memory-publish.mjs";

const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(args) {
	let packageRoot = defaultPackageRoot;
	let distRoot;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument !== "--package-root" && argument !== "--dist") throw new Error(`Unknown argument: ${argument}`);
		const value = args[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path`);
		if (argument === "--package-root") packageRoot = resolve(value);
		else distRoot = resolve(value);
		index += 1;
	}
	return { packageRoot, distRoot: distRoot ?? join(packageRoot, "dist") };
}

function walkFiles(root) {
	const files = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...walkFiles(path));
		else if (entry.isFile() || statSync(path).isFile()) files.push(path);
	}
	return files;
}

function requireFile(root, path, missing) {
	if (!existsSync(join(root, path))) missing.push(path);
}

const { packageRoot, distRoot } = parseArguments(process.argv.slice(2));
const sourceRoot = join(packageRoot, "src");
const legacyRoot = join(distRoot, "legacy");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const missing = [];
const stale = [];
const sourceFiles = walkFiles(sourceRoot).filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts"));

for (const sourcePath of sourceFiles) {
	const outputPath = relative(sourceRoot, sourcePath).slice(0, -3);
	for (const suffix of [".js", ".js.map", ".d.ts", ".d.ts.map"]) {
		requireFile(distRoot, `${outputPath}${suffix}`, missing);
	}
	const sourceMapPath = join(distRoot, `${outputPath}.js.map`);
	if (existsSync(sourceMapPath)) {
		try {
			const sourceMap = JSON.parse(readFileSync(sourceMapPath, "utf8"));
			if (!Array.isArray(sourceMap.sourcesContent) || !sourceMap.sourcesContent.includes(readFileSync(sourcePath, "utf8"))) {
				stale.push(`${outputPath}.js`);
			}
		} catch {
			stale.push(`${outputPath}.js`);
		}
	}
}

const bins = packageJson.bin && typeof packageJson.bin === "object" ? Object.entries(packageJson.bin) : [];
if (bins.length === 0) throw new Error("Package does not declare any executable entry points");
for (const [name, target] of bins) {
	if (typeof target !== "string") throw new Error(`Invalid bin target for ${name}`);
	const declaredPath = resolve(packageRoot, target);
	const defaultDistRoot = join(packageRoot, "dist");
	const relativeToDist = relative(defaultDistRoot, declaredPath);
	const targetPath =
		relativeToDist !== ".." && !relativeToDist.startsWith(`..${sep}`) ? join(distRoot, relativeToDist) : declaredPath;
	if (!existsSync(targetPath)) missing.push(target);
	if (existsSync(targetPath) && process.platform !== "win32") {
		try {
			accessSync(targetPath, constants.X_OK);
		} catch {
			throw new Error(`Package executable is not marked executable: ${target}`);
		}
	}
}

for (const required of ["ultracode-verifier.py", "requirements-ultracode.txt"]) {
	requireFile(distRoot, required, missing);
}

for (const required of [
	".secheur-runtime.json",
	"secheur_pi_bridge.py",
	"runtime_session_log.py",
	"assets/tools_schema.json",
	"ctf-mcp/server.py",
	"frontends/desktop/static/index.html",
	"frontends/desktop/static/updates.html",
	"frontends/desktop/static/webui/index.html",
	"frontends/desktop/static/app.js",
	"frontends/desktop/static/desktop-plugins.js",
	"frontends/desktop/static/styles.css",
	"frontends/desktop/static/trajectory-viewer.css",
	"frontends/desktop/static/trajectory-viewer.js",
	"frontends/desktop/plugins/conversation-trace-ui/package.json",
	"frontends/desktop/plugins/conversation-trace-ui/README.md",
	"frontends/desktop/plugins/conversation-trace-ui/index.js",
	"frontends/desktop/plugins/conversation-trace-ui/desktop/conversation-trace.css",
	"frontends/desktop/plugins/conversation-trace-ui/desktop/conversation-trace.js",
	"ctf-benchmark-dashboard/index.html",
	"ctf-benchmark-dashboard/assets/scoreboard.png",
	"ctf-benchmark-dashboard/assets/forensic-dossier.png",
	"ctf-benchmark-dashboard/assets/challenge-board.png",
	"memory/attack_memory/crypto_v1/knowledge/cards.jsonl",
	"memory/attack_memory/pwn_v2/records.jsonl",
	".agents/skills/ctf-crypto/SKILL.md",
	".agents/skills/ctf-pwn/SKILL.md",
	".agents/skills/ctf-web/SKILL.md",
	".agents/skills/solve-challenge/SKILL.md",
]) {
	requireFile(legacyRoot, required, missing);
}

if (missing.length > 0) {
	throw new Error(`Distribution is incomplete:\n${missing.map((path) => `- ${path}`).join("\n")}`);
}
if (stale.length > 0) {
	throw new Error(`Distribution contains stale compiled modules:\n${stale.map((path) => `- ${path}`).join("\n")}`);
}

const marker = JSON.parse(readFileSync(join(legacyRoot, ".secheur-runtime.json"), "utf8"));
if (marker.schemaVersion !== 1) throw new Error("Unsupported legacy runtime marker");

const toolSchema = JSON.parse(readFileSync(join(legacyRoot, "assets", "tools_schema.json"), "utf8"));
if (!Array.isArray(toolSchema) || toolSchema.length === 0) throw new Error("Legacy tool schema is empty or invalid");

const forbiddenNames = new Set([".env", "auth.json", "mykey.py", "mykey.py.bak"]);
const forbiddenDirectories = new Set([
	".git",
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
const forbiddenFiles = [];
const legacyFiles = walkFiles(legacyRoot);
for (const path of legacyFiles) {
	const relativePath = relative(legacyRoot, path);
	const normalizedPath = relativePath.split(sep).join("/");
	const parts = relativePath.split(sep);
	const name = parts.at(-1) ?? "";
	if (
		forbiddenNames.has(name) ||
		parts.some((part) => forbiddenDirectories.has(part)) ||
		name.endsWith(".pyc") ||
		name.endsWith(".pyo") ||
		name.endsWith(".log") ||
		(normalizedPath.startsWith(ATTACK_MEMORY_INDEX_ROOT) &&
			!isPublishedAttackMemoryEntry(normalizedPath, path)) ||
		relativePath.startsWith(join("frontends", "desktop", "src-tauri", sep))
	) {
		forbiddenFiles.push(relativePath);
	}
}
if (forbiddenFiles.length > 0) {
	throw new Error(`Distribution contains excluded or sensitive files:\n${forbiddenFiles.map((path) => `- ${path}`).join("\n")}`);
}

console.log(
	`Verified ${sourceFiles.length} compiled modules, ${bins.length} executables, and ${legacyFiles.length} legacy runtime files in ${distRoot}`,
);
