import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(packageRoot, "../repoaudit-pi-extension");
const defaultDestination = join(packageRoot, "node_modules", "@repoaudit", "typescript-adapter");
const markerName = ".secheur-bundled-dependency.json";

function parseArguments(args) {
	let destination = defaultDestination;
	let replace = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--replace") {
			replace = true;
			continue;
		}
		if (argument === "--destination") {
			const value = args[index + 1];
			if (!value || value.startsWith("--")) throw new Error("--destination requires a path");
			destination = resolve(value);
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${argument}`);
	}
	return { destination, replace };
}

function containsPath(parent, child) {
	const childPath = relative(parent, child);
	return childPath === "" || (!childPath.startsWith(`..${sep}`) && childPath !== ".." && !isAbsolute(childPath));
}

function copyDirectory(source, destination) {
	mkdirSync(destination, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const sourcePath = join(source, entry.name);
		const destinationPath = join(destination, entry.name);
		if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath);
		else if (entry.isFile()) copyFileSync(sourcePath, destinationPath);
	}
}

const { destination, replace } = parseArguments(process.argv.slice(2));
const sourceManifestPath = join(sourceRoot, "package.json");
const sourceEntry = join(sourceRoot, "dist", "src", "index.js");
if (!existsSync(sourceManifestPath) || !existsSync(sourceEntry)) {
	throw new Error("RepoAudit extension must be built before staging the SecHeur production dependency");
}
if (containsPath(sourceRoot, destination) || containsPath(destination, sourceRoot)) {
	throw new Error(`Refusing an overlapping RepoAudit bundle destination: ${destination}`);
}
if (existsSync(destination)) {
	if (!replace) throw new Error(`RepoAudit bundle destination already exists: ${destination}`);
	if (!existsSync(join(destination, markerName))) {
		throw new Error(`Refusing to replace an unmarked RepoAudit bundle destination: ${destination}`);
	}
	rmSync(destination, { recursive: true, force: true });
}

const manifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
if (manifest.name !== "@repoaudit/typescript-adapter" || manifest.version !== "0.1.0") {
	throw new Error("Unexpected RepoAudit extension package identity");
}
mkdirSync(join(destination, "dist"), { recursive: true });
copyDirectory(join(sourceRoot, "dist", "src"), join(destination, "dist", "src"));
copyFileSync(sourceManifestPath, join(destination, "package.json"));
copyFileSync(join(sourceRoot, "README.md"), join(destination, "README.md"));
writeFileSync(
	join(destination, markerName),
	`${JSON.stringify({ name: manifest.name, version: manifest.version, source: "workspace-build" }, null, 2)}\n`,
);
console.log(`Staged RepoAudit ${manifest.version} production dependency in ${destination}`);
