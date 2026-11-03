import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rootManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const agentManifest = JSON.parse(
	readFileSync(new URL("../packages/secheur-agent/package.json", import.meta.url), "utf8"),
);
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const dockerignore = readFileSync(new URL("../.dockerignore", import.meta.url), "utf8");
const dockerSmoke = readFileSync(new URL("../docker/repoaudit-smoke.sh", import.meta.url), "utf8");
const grammarBuild = readFileSync(new URL("../vendor/repoaudit/lib/build.py", import.meta.url), "utf8");

test("root builds RepoAudit before SecHeur in online and offline builds", () => {
	for (const scriptName of ["build", "build:offline"]) {
		const script = rootManifest.scripts[scriptName];
		assert.match(script, /repoaudit-pi-extension/);
		assert.ok(
			script.indexOf("repoaudit-pi-extension") < script.indexOf("secheur-agent"),
			`${scriptName} must build RepoAudit before SecHeur`,
		);
	}
});

test("the production SecHeur package carries the RepoAudit workspace dependency", () => {
	assert.equal(agentManifest.dependencies["@repoaudit/typescript-adapter"], "0.1.0");
	assert.ok(agentManifest.bundledDependencies.includes("@repoaudit/typescript-adapter"));
	assert.match(agentManifest.scripts.build, /stage-repoaudit-extension\.mjs/);
});

test("Docker pins Python 3.13 and the version-controlled RepoAudit runtime", () => {
	assert.match(dockerfile, /python:3\.13[^\s]*-bookworm/);
	assert.match(dockerfile, /COPY\s+vendor\/repoaudit/);
	assert.match(dockerfile, /REPOAUDIT_ROOT=\/opt\/repoaudit/);
	assert.match(dockerfile, /REPOAUDIT_PYTHON=\/opt\/repoaudit-venv\/bin\/python/);
	assert.match(dockerfile, /REPOAUDIT_REQUIRE_API_KEY=1/);
	assert.match(dockerfile, /REPOAUDIT_REQUIRE_API_KEY=0[^\n]*repoaudit-smoke/);
	assert.match(dockerSmoke, /REPOAUDIT_REQUIRE_API_KEY=0[^\n]*repoaudit-doctor/);
	assert.doesNotMatch(dockerfile, /git\s+clone[^\n]*repoaudit/i);
	assert.equal([...grammarBuild.matchAll(/git checkout ([0-9a-f]{40})/g)].length, 5);
	for (const directory of ["node_modules", "dist", ".venv", "log", "result", "runs", "lock"]) {
		assert.match(dockerignore, new RegExp(`(?:^|\\n)\\*\\*/${directory}(?:\\n|$)`));
	}
});
