import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SecHeurBridge } from "../src/bridge.ts";
import { assertRepoAuditPluginLoaded, createSecHeurRuntime } from "../src/runtime.ts";

const bridges: SecHeurBridge[] = [];
const roots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "secheur-repoaudit-integration-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	for (const bridge of bridges.splice(0)) await bridge.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("RepoAudit Pi integration", () => {
	it("loads the real extension and exposes repoaudit_scan without a model", async () => {
		const runtime = await createSecHeurRuntime({
			projectRoot: temporaryRoot(),
			persist: false,
			env: { ...process.env, PI_OFFLINE: "1", REPOAUDIT_REQUIRE_API_KEY: "0" },
		});
		try {
			expect(runtime.session.getAllTools().map((tool) => tool.name)).toContain("repoaudit_scan");
			expect(runtime.session.getActiveToolNames()).toContain("repoaudit_scan");
		} finally {
			runtime.dispose();
		}
	});

	it("reports PLUGIN_NOT_LOADED with loader diagnostics", () => {
		expect(() => assertRepoAuditPluginLoaded([], [{ path: "repoaudit", error: "fixture load failure" }])).toThrow(
			/PLUGIN_NOT_LOADED.*fixture load failure/,
		);
	});

	it("creates a Bridge session and discovers repoaudit_scan", async () => {
		const root = temporaryRoot();
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			env: { ...process.env, PI_OFFLINE: "1", REPOAUDIT_REQUIRE_API_KEY: "0" },
			schedulerBackend: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then(async (response) => {
			expect(response.status).toBe(201);
			return response.json();
		})) as { sessionId: string };

		const discovered = (await fetch(`${base}/session/${created.sessionId}/tools`).then(async (response) => {
			expect(response.status).toBe(200);
			return response.json();
		})) as { tools: string[]; activeTools: string[] };
		expect(discovered.tools).toContain("repoaudit_scan");
		expect(discovered.activeTools).toContain("repoaudit_scan");
	});
});
