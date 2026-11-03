import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { disabledRegistryNames, loadSecHeurConfig } from "../src/config.ts";
import { setBuiltinPlanningEnabled } from "../src/plugin-catalog.ts";

describe("active planning configuration", () => {
	it("forces legacy tree tools off and persists the frontend toggle as active", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-planning-config-"));
		const stateDir = join(root, "state");
		const legacyRoot = join(root, "legacy");
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(legacyRoot, { recursive: true });
		writeFileSync(join(stateDir, "desktop-config.json"), JSON.stringify({ planning: { mode: "off" } }));
		writeFileSync(
			join(stateDir, "settings.json"),
			JSON.stringify({
				tools: { plan_expand: true, plan_revise: true, plan_status: true, file_read: true },
			}),
		);
		try {
			const off = loadSecHeurConfig({ projectRoot: root, stateDir, legacyRoot, env: {} });
			expect(off.planning).toMatchObject({
				globalExecutorCapacity: undefined,
				evidenceCatalogEnabled: true,
				observerMode: "off",
				taskGranularityPromptEnabled: false,
				executorContextBytes: off.planning.maxEvidenceBytes,
			});
			setBuiltinPlanningEnabled(off, true);
			const active = loadSecHeurConfig({ projectRoot: root, stateDir, legacyRoot, env: {} });
			expect(active.planning.mode).toBe("active");
			expect(active.executionMode).toMatchObject({ mode: "plan_single", capacity: 1 });
			expect(disabledRegistryNames(active, "tools")).toEqual(
				expect.arrayContaining(["plan_expand", "plan_revise", "plan_status"]),
			);
			expect(disabledRegistryNames(active, "tools")).not.toContain("file_read");
			const settings = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8")) as {
				tools: Record<string, boolean>;
			};
			expect(settings.tools).toMatchObject({ plan_expand: false, plan_revise: false, plan_status: false });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps the Executor context budget independent from feature switches", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-planning-experiment-config-"));
		const stateDir = join(root, "state");
		const legacyRoot = join(root, "legacy");
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(legacyRoot, { recursive: true });
		try {
			writeFileSync(
				join(stateDir, "desktop-config.json"),
				JSON.stringify({
					planning: {
						evidenceCatalogEnabled: true,
						observerMode: "guidance",
						taskGranularityPromptEnabled: true,
						maxEvidenceBytes: 32_768,
						global_executor_capacity: 4,
						executorContextBytes: 49_152,
					},
				}),
			);
			const config = loadSecHeurConfig({ projectRoot: root, stateDir, legacyRoot, env: {} });
			expect(config.planning).toMatchObject({
				globalExecutorCapacity: 4,
				evidenceCatalogEnabled: true,
				observerMode: "guidance",
				taskGranularityPromptEnabled: true,
				maxEvidenceBytes: 32_768,
				executorContextBytes: 49_152,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each(["evidenceCatalogEnabled", "evidence_catalog_enabled"])(
		"preserves an explicit catalog opt-out through %s",
		async (field) => {
			const root = await mkdtemp(join(tmpdir(), "secheur-planning-catalog-off-"));
			const stateDir = join(root, "state");
			mkdirSync(stateDir, { recursive: true });
			try {
				writeFileSync(join(stateDir, "desktop-config.json"), JSON.stringify({ planning: { [field]: false } }));
				expect(
					loadSecHeurConfig({ projectRoot: root, stateDir, legacyRoot: root, env: {} }).planning
						.evidenceCatalogEnabled,
				).toBe(false);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it("canonicalizes execution capacity when the Planning toggle changes mode", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-planning-toggle-canonical-"));
		const stateDir = join(root, "state");
		const legacyRoot = join(root, "legacy");
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(legacyRoot, { recursive: true });
		try {
			const writeDesktopConfig = (value: unknown): void =>
				writeFileSync(join(stateDir, "desktop-config.json"), `${JSON.stringify(value)}\n`);

			writeDesktopConfig({ executionMode: "plan_multi", executionCapacity: 2 });
			let config = loadSecHeurConfig({ projectRoot: root, stateDir, legacyRoot, env: {} });
			setBuiltinPlanningEnabled(config, false);
			config = loadSecHeurConfig({ projectRoot: root, stateDir, legacyRoot, env: {} });
			expect(config.executionMode).toMatchObject({ mode: "direct", planningEnabled: false, capacity: 1 });
			expect(JSON.parse(readFileSync(join(stateDir, "desktop-config.json"), "utf8"))).toMatchObject({
				executionMode: "direct",
				executionCapacity: 1,
			});

			setBuiltinPlanningEnabled(config, true);
			config = loadSecHeurConfig({ projectRoot: root, stateDir, legacyRoot, env: {} });
			expect(config.executionMode).toMatchObject({ mode: "plan_single", planningEnabled: true, capacity: 1 });

			writeDesktopConfig({ executionMode: "plan_multi", executionCapacity: 3 });
			config = loadSecHeurConfig({ projectRoot: root, stateDir, legacyRoot, env: {} });
			setBuiltinPlanningEnabled(config, true);
			config = loadSecHeurConfig({ projectRoot: root, stateDir, legacyRoot, env: {} });
			expect(config.executionMode).toMatchObject({ mode: "plan_multi", planningEnabled: true, capacity: 3 });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
