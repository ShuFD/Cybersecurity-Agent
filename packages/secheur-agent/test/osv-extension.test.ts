import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompetitionSolverBinding } from "../src/competition-solver.ts";
import { loadSecHeurConfig } from "../src/config.ts";
import { createSecHeurExtension } from "../src/extension.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "secheur-osv-extension-"));
	temporaryRoots.push(root);
	return root;
}

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function makeCompetition(sendEvent = vi.fn(async () => ({ accepted: true }))): {
	competition: CompetitionSolverBinding;
	sendEvent: typeof sendEvent;
} {
	return {
		competition: { taskId: "ctfd:1", sendEvent } as unknown as CompetitionSolverBinding,
		sendEvent,
	};
}

function createTools(root: string, competition?: CompetitionSolverBinding) {
	const config = loadSecHeurConfig({
		projectRoot: root,
		legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
		env: {},
	});
	const created = createSecHeurExtension({
		config,
		env: { ...process.env, PI_OFFLINE: "1", OSV_API_URL: "https://osv.test" },
		...(competition ? { competition } : {}),
	});
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const pi = {
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
			tools.set(tool.name, tool),
		registerCommand: () => undefined,
		on: () => undefined,
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => undefined,
	};
	if (typeof created.extension === "function") created.extension(pi as never);
	else created.extension.factory(pi as never);
	return { created, tools };
}

afterEach(() => {
	vi.unstubAllGlobals();
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("solver OSV tool", () => {
	it("is registered only for competition solver sessions", () => {
		const root = temporaryRoot();
		const withoutCompetition = createTools(root);
		try {
			expect(withoutCompetition.tools.has("osv_query")).toBe(false);
		} finally {
			withoutCompetition.created.state.close();
		}

		const withCompetition = makeCompetition();
		const solver = createTools(root, withCompetition.competition);
		try {
			expect(solver.tools.has("osv_query")).toBe(true);
		} finally {
			solver.created.state.close();
		}
	});

	it("skips a constructed CTF target without contacting OSV", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }));
		vi.stubGlobal("fetch", fetchImpl);
		const root = temporaryRoot();
		const { competition, sendEvent } = makeCompetition();
		const { created, tools } = createTools(root, competition);
		try {
			const result = (await tools.get("osv_query")?.execute(
				"call-1",
				{
					target_type: "constructed_ctf",
					targets: [{ evidence_refs: ["challenge.md:1"] }],
				},
				undefined,
				undefined,
				{ hasUI: false },
			)) as { details?: Record<string, unknown> };

			expect(result.details).toMatchObject({ status: "skipped", classification: "constructed_ctf" });
			expect(fetchImpl).not.toHaveBeenCalled();
			expect(sendEvent).not.toHaveBeenCalled();
		} finally {
			created.state.close();
		}
	});

	it("waits for uncertain classification and records confirmed OSV evidence", async () => {
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/v1/querybatch"))
				return jsonResponse({ results: [{ vulns: [{ id: "GHSA-demo-1234", modified: "now" }] }] });
			if (url.endsWith("/v1/vulns/GHSA-demo-1234"))
				return jsonResponse({
					id: "GHSA-demo-1234",
					summary: "Demo vulnerability",
					database_specific: { severity: "HIGH" },
					affected: [{ ranges: [{ type: "SEMVER", events: [{ fixed: "2.0.0" }] }] }],
				});
			throw new Error(`unexpected URL ${url}`);
		});
		vi.stubGlobal("fetch", fetchImpl);
		const root = temporaryRoot();
		const { competition, sendEvent } = makeCompetition();
		const { created, tools } = createTools(root, competition);
		try {
			const pending = tools.get("osv_query")?.execute(
				"call-1",
				{
					target_type: "uncertain",
					targets: [
						{
							package_name: "demo-package",
							ecosystem: "npm",
							version: "1.2.3",
							evidence_refs: ["package-lock.json:42"],
						},
					],
				},
				undefined,
				undefined,
				{ hasUI: false },
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			const request = created.state.permissionBroker.list()[0];
			expect(request).toMatchObject({ toolName: "ask_user", message: expect.stringContaining("目标性质不明确") });
			expect(fetchImpl).not.toHaveBeenCalled();
			expect(request).toBeDefined();
			created.state.permissionBroker.resolve(request!.id, true, "real_world_software");

			const result = (await pending) as { details?: Record<string, unknown> };
			expect(result.details).toMatchObject({
				status: "ok",
				classification: "real_world_software",
				confirmation: "operator",
			});
			expect(result.details?.evidence_ids).toEqual([expect.stringMatching(/^osv-/u)]);
			expect(sendEvent).toHaveBeenCalledWith(
				"evidence",
				expect.objectContaining({
					kind: "observation",
					source: "osv.dev",
					refs: ["package-lock.json:42", "https://osv.dev/vulnerability/GHSA-demo-1234"],
				}),
			);
		} finally {
			created.state.close();
		}
	});

	it("bounds both model content and structured tool details", async () => {
		const vulnerabilityIds = Array.from({ length: 50 }, (_value, index) => `OSV-large-${index}`);
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/v1/querybatch"))
				return jsonResponse({ results: [{ vulns: vulnerabilityIds.map((id) => ({ id, modified: "now" })) }] });
			if (url.includes("/v1/vulns/")) return jsonResponse({ id: url.split("/").at(-1), summary: "x".repeat(1_000) });
			throw new Error(`unexpected URL ${url}`);
		});
		vi.stubGlobal("fetch", fetchImpl);
		const root = temporaryRoot();
		const { competition, sendEvent } = makeCompetition();
		const { created, tools } = createTools(root, competition);
		try {
			const result = (await tools.get("osv_query")?.execute(
				"call-large",
				{
					target_type: "real_world_software",
					targets: [
						{
							package_name: "demo-package",
							ecosystem: "npm",
							version: "1.2.3",
							evidence_refs: ["package-lock.json:42"],
						},
					],
				},
				undefined,
				undefined,
				{ hasUI: false },
			)) as { content?: Array<{ text?: string }>; details?: Record<string, unknown> };
			const content = result.content?.[0]?.text ?? "";
			expect(content.length).toBeLessThanOrEqual(24_000);
			expect(() => JSON.parse(content)).not.toThrow();
			expect(result.details?.results).toHaveLength(1);
			expect((result.details?.results as Array<Record<string, unknown>>)[0]?.vulnerability_ids).toHaveLength(8);
			expect(sendEvent).toHaveBeenCalledTimes(1);
		} finally {
			created.state.close();
		}
	});
});
