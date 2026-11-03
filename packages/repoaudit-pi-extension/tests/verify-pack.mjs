import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "npm_execpath is required; run this verifier through npm run verify:pack");

const temporaryRoot = mkdtempSync(path.join(tmpdir(), "repoaudit-clean-install-"));
const npmCache = path.join(temporaryRoot, "npm-cache");
const packDirectory = path.join(temporaryRoot, "pack");
const installDirectory = path.join(temporaryRoot, "install");
mkdirSync(packDirectory, { recursive: true });
mkdirSync(installDirectory, { recursive: true });

let summary;
try {
  const environment = { ...process.env, npm_config_cache: npmCache };
  const output = execFileSync(
    process.execPath,
    [npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
    { cwd: process.cwd(), encoding: "utf8", env: environment },
  );
  const report = JSON.parse(output)[0];
  const files = report.files.map((entry) => entry.path);

  assert.ok(files.includes("dist/src/index.js"));
  assert.ok(files.includes("dist/src/doctor-cli.js"));
  assert.ok(files.includes("README.md"));
  for (const forbidden of ["node_modules/", ".venv/", "dist/tests/", "log/", "result/", "runs/", "lock/"]) {
    assert.equal(files.some((file) => file.startsWith(forbidden)), false, forbidden);
  }
  assert.equal(files.some((file) => /(^|\/)(\.env|.*\.log|.*\.tgz)$/.test(file)), false);

  const packageRoot = path.resolve(process.cwd());
  const embeddedRootVariants = [packageRoot, packageRoot.replaceAll("\\", "/")];
  for (const file of files.filter((candidate) => candidate.startsWith("dist/") || candidate === "package.json")) {
    const contents = readFileSync(path.join(packageRoot, file), "utf8");
    for (const embeddedRoot of embeddedRootVariants) {
      assert.equal(contents.includes(embeddedRoot), false, `embedded absolute build path in ${file}`);
    }
  }

  const tarballPath = path.join(packDirectory, report.filename);
  const localRequire = createRequire(path.join(packageRoot, "verify.cjs"));
  const typeboxEntryPath = localRequire.resolve("typebox");
  const typeboxPackageRoot = path.dirname(path.dirname(typeboxEntryPath));
  execFileSync(
    process.execPath,
    [
      npmCli,
      "install",
      tarballPath,
      typeboxPackageRoot,
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--offline",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: installDirectory, encoding: "utf8", env: environment, stdio: "pipe" },
  );

  const installedPackageRoot = path.join(
    installDirectory,
    "node_modules",
    "@repoaudit",
    "typescript-adapter",
  );
  const installedManifest = JSON.parse(readFileSync(path.join(installedPackageRoot, "package.json"), "utf8"));
  assert.deepEqual(installedManifest.pi?.extensions, ["./dist/src/index.js"]);
  const extensionPath = path.resolve(installedPackageRoot, installedManifest.pi.extensions[0]);
  const piEntryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { parseArgs } = await import(pathToFileURL(piEntryPath).href);
  const loaderPath = path.join(path.dirname(piEntryPath), "core", "extensions", "loader.js");
  const { loadExtensions } = await import(pathToFileURL(loaderPath).href);

  const parsed = parseArgs(["-e", extensionPath]);
  assert.deepEqual(parsed.extensions, [extensionPath]);
  const loaded = await loadExtensions(parsed.extensions, installDirectory);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const toolNames = [...loaded.extensions[0].tools.keys()];
  assert.deepEqual(toolNames, ["repoaudit_scan"]);

  summary = {
    fileCount: files.length,
    unpackedSize: report.unpackedSize,
    cleanInstall: true,
    extensionCount: loaded.extensions.length,
    toolNames,
    files,
  };
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log(JSON.stringify(summary, null, 2));
