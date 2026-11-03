import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Include the adapted upstream's license/provenance in distributable artifacts.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(packageRoot, "../../vendor/cairnpilot");
const target = join(packageRoot, "dist/planning/cairn");
mkdirSync(target, { recursive: true });
for (const file of ["LICENSE", "NOTICE.md"]) copyFileSync(join(source, file), join(target, file));
