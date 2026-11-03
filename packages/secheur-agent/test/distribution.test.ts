import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const stageScript = join(packageRoot, "scripts", "stage-legacy.mjs");
const stageRepoAuditScript = join(packageRoot, "scripts", "stage-repoaudit-extension.mjs");
const ultracodeStageScript = join(packageRoot, "scripts", "stage-ultracode.mjs");
const verifyScript = join(packageRoot, "scripts", "verify-dist.mjs");
const tsxScript = resolve(packageRoot, "../../node_modules/tsx/dist/cli.mjs");
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "secheur-dist-test-"));
	temporaryRoots.push(root);
	return root;
}

function runScript(script: string, args: string[]) {
	return spawnSync(process.execPath, [script, ...args], { cwd: packageRoot, encoding: "utf8" });
}

function createCompiledOutputs(distRoot: string): void {
	mkdirSync(distRoot, { recursive: true });
	for (const entry of readdirSync(join(packageRoot, "src"), { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
		const outputName = entry.name.slice(0, -3);
		const source = readFileSync(join(packageRoot, "src", entry.name), "utf8");
		writeFileSync(join(distRoot, `${outputName}.js`), "export {};\n");
		writeFileSync(
			join(distRoot, `${outputName}.js.map`),
			JSON.stringify({
				version: 3,
				file: `${outputName}.js`,
				sources: [`../src/${entry.name}`],
				sourcesContent: [source],
				names: [],
				mappings: "",
			}),
		);
		writeFileSync(join(distRoot, `${outputName}.d.ts`), "export {};\n");
		writeFileSync(join(distRoot, `${outputName}.d.ts.map`), "{}\n");
	}
	for (const executable of ["cli.js", "bridge-cli.js", "protocol-cli.js", "competition-cli.js"])
		chmodSync(join(distRoot, executable), 0o755);
}

function createRecursiveCompiledOutputs(distRoot: string): void {
	mkdirSync(distRoot, { recursive: true });
	const sourceRoot = join(packageRoot, "src");
	const visit = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const sourcePath = join(current, entry.name);
			if (entry.isDirectory()) { visit(sourcePath); continue; }
			if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
			const relativeSource = sourcePath.slice(sourceRoot.length + 1).replaceAll("\\", "/");
			const outputName = relativeSource.slice(0, -3);
			const outputPath = join(distRoot, outputName);
			mkdirSync(join(outputPath, ".."), { recursive: true });
			const source = readFileSync(sourcePath, "utf8");
			writeFileSync(`${outputPath}.js`, "export {};\n");
			writeFileSync(`${outputPath}.js.map`, JSON.stringify({ version: 3, file: `${outputName}.js`, sources: [`../src/${relativeSource}`], sourcesContent: [source], names: [], mappings: "" }));
			writeFileSync(`${outputPath}.d.ts`, "export {};\n");
			writeFileSync(`${outputPath}.d.ts.map`, "{}\n");
		}
	};
	visit(sourceRoot);
	for (const executable of ["cli.js", "bridge-cli.js", "protocol-cli.js", "competition-cli.js"]) chmodSync(join(distRoot, executable), 0o755);
}
afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("distribution scripts", () => {
	it("stages only the publishable RepoAudit extension into a production dependency", () => {
		const destination = join(temporaryRoot(), "repoaudit-bundle");
		const staged = runScript(stageRepoAuditScript, ["--destination", destination]);
		expect(staged.status, staged.stderr).toBe(0);
		expect(existsSync(join(destination, "dist", "src", "index.js"))).toBe(true);
		expect(existsSync(join(destination, "dist", "src", "doctor-cli.js"))).toBe(true);
		expect(existsSync(join(destination, "package.json"))).toBe(true);
		expect(existsSync(join(destination, "tests"))).toBe(false);
		expect(existsSync(join(destination, "node_modules"))).toBe(false);

		const replaced = runScript(stageRepoAuditScript, ["--destination", destination, "--replace"]);
		expect(replaced.status, replaced.stderr).toBe(0);
	});

	it("prints bridge help without starting the server", () => {
		const help = runScript(tsxScript, [join(packageRoot, "src", "bridge-cli.ts"), "--help"]);
		expect(help.status, help.stderr).toBe(0);
		expect(help.stdout).toContain("Usage: secheur-bridge");
		expect(help.stderr).not.toContain("SecHeur Agent bridge:");
	}, 30_000);

	it("replaces only marked destinations and verifies a complete distribution", () => {
		const root = temporaryRoot();
		const distRoot = join(root, "dist");
		const legacyRoot = join(distRoot, "legacy");
		createRecursiveCompiledOutputs(distRoot);

		const firstStage = runScript(stageScript, ["--destination", legacyRoot]);
		expect(firstStage.status, firstStage.stderr).toBe(0);
		const secondStage = runScript(stageScript, ["--destination", legacyRoot, "--replace"]);
		expect(secondStage.status, secondStage.stderr).toBe(0);
		const ultracodeStage = runScript(ultracodeStageScript, ["--dist", distRoot]);
		expect(ultracodeStage.status, ultracodeStage.stderr).toBe(0);

		const verification = runScript(verifyScript, ["--dist", distRoot]);
		expect(verification.status, verification.stderr).toBe(0);
		expect(verification.stdout).toContain("Verified");

		for (const filename of ["scoreboard.png", "forensic-dossier.png", "challenge-board.png"]) {
			const imagePath = join(legacyRoot, "ctf-benchmark-dashboard", "assets", filename);
			const image = readFileSync(imagePath);
			rmSync(imagePath);
			const missingImageVerification = runScript(verifyScript, ["--dist", distRoot]);
			expect(missingImageVerification.status).not.toBe(0);
			expect(missingImageVerification.stderr).toContain(`ctf-benchmark-dashboard/assets/${filename}`);
			writeFileSync(imagePath, image);
		}

		const indexMapPath = join(distRoot, "index.js.map");
		const indexMap = JSON.parse(readFileSync(indexMapPath, "utf8")) as Record<string, unknown>;
		writeFileSync(indexMapPath, JSON.stringify({ ...indexMap, sourcesContent: ["stale source"] }));
		const staleVerification = runScript(verifyScript, ["--dist", distRoot]);
		expect(staleVerification.status).not.toBe(0);
		expect(staleVerification.stderr).toContain("stale compiled modules");
		writeFileSync(
			indexMapPath,
			JSON.stringify({ ...indexMap, sourcesContent: [readFileSync(join(packageRoot, "src", "index.ts"), "utf8")] }),
		);

		writeFileSync(join(legacyRoot, "mykey.py"), "API_KEY = 'should-not-ship'\n");
		const sensitiveVerification = runScript(verifyScript, ["--dist", distRoot]);
		expect(sensitiveVerification.status).not.toBe(0);
		expect(sensitiveVerification.stderr).toContain("mykey.py");
	});

	it("preserves an unmarked destination and reports a missing executable", () => {
		const root = temporaryRoot();
		const unmarkedRoot = join(root, "unmarked");
		mkdirSync(unmarkedRoot);
		writeFileSync(join(unmarkedRoot, "keep.txt"), "keep\n");

		const refusedStage = runScript(stageScript, ["--destination", unmarkedRoot, "--replace"]);
		expect(refusedStage.status).not.toBe(0);
		expect(refusedStage.stderr).toContain("unmarked legacy staging destination");
		expect(existsSync(join(unmarkedRoot, "keep.txt"))).toBe(true);

		const distRoot = join(root, "dist");
		createRecursiveCompiledOutputs(distRoot);
		const staged = runScript(stageScript, ["--destination", join(distRoot, "legacy")]);
		expect(staged.status, staged.stderr).toBe(0);
		const ultracodeStage = runScript(ultracodeStageScript, ["--dist", distRoot]);
		expect(ultracodeStage.status, ultracodeStage.stderr).toBe(0);
		rmSync(join(distRoot, "protocol-cli.js"));

		const verification = runScript(verifyScript, ["--dist", distRoot]);
		expect(verification.status).not.toBe(0);
		expect(verification.stderr).toContain("dist/protocol-cli.js");
	});
});
