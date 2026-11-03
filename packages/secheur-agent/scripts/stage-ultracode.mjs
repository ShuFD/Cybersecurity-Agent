import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let distRoot = join(packageRoot, "dist");
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
	if (args[index] !== "--dist") throw new Error(`Unknown argument: ${args[index]}`);
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error("--dist requires a path");
	distRoot = resolve(value);
	index += 1;
}
const files = ["ultracode-verifier.py", "requirements-ultracode.txt"];

mkdirSync(distRoot, { recursive: true });
for (const file of files) {
	const source = join(packageRoot, file);
	if (!existsSync(source)) throw new Error(`Ultracode release file is missing: ${source}`);
	copyFileSync(source, join(distRoot, file));
}
chmodSync(join(distRoot, "ultracode-verifier.py"), 0o755);
