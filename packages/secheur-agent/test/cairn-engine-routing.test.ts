import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { resolveExecutionMode } from "../src/execution-mode.ts";
import { CairnPlanningEngine } from "../src/planning/cairn/engine.ts";
import { attachProgressivePlanningController } from "../src/planning/session-controller.ts";
import { setBuiltinPlanningEnabled } from "../src/plugin-catalog.ts";

function setup(root: string) {
	const config = loadSecHeurConfig({
		projectRoot: root,
		stateDir: join(root, "state"),
		legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
		env: {},
	});
	const custom = vi.fn(async () => {}),
		direct = vi.fn(async () => {});
	const session = {
		sessionId: "routing",
		model: undefined,
		thinkingLevel: "off",
		prompt: direct,
		sendCustomMessage: custom,
	} as unknown as AgentSession;
	return { config, session, custom, direct };
}
describe("independent Planning engine selection", () => {
	it("keeps progressive as the old-config default and persists Cairn plugin selection without changing capacity", () => {
		const root = mkdtempSync(join(tmpdir(), "cairn-plugin-"));
		try {
			const { config } = setup(root);
			expect(config.planning.engine).toBe("progressive");
			config.executionMode = resolveExecutionMode({ mode: "plan_multi", capacity: 3 });
			setBuiltinPlanningEnabled(config, true, "cairn");
			const selected = loadSecHeurConfig({
				projectRoot: root,
				stateDir: config.stateDir,
				legacyRoot: config.legacyRoot,
				env: {},
			});
			expect(selected.planning.engine).toBe("cairn");
			expect(selected.executionMode.capacity).toBe(3);
			setBuiltinPlanningEnabled(selected, false, "progressive");
			const after = JSON.parse(readFileSync(join(config.stateDir, "desktop-config.json"), "utf8"));
			expect(after.executionMode).toBe("plan_multi");
			expect(after.planning.engine).toBe("cairn");
			setBuiltinPlanningEnabled(selected, true, "progressive");
			expect(JSON.parse(readFileSync(join(config.stateDir, "desktop-config.json"), "utf8")).planning.engine).toBe(
				"progressive",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("DIRECT bypasses both engines even when Cairn is selected", async () => {
		const root = mkdtempSync(join(tmpdir(), "cairn-direct-"));
		const execute = vi.spyOn(CairnPlanningEngine.prototype, "execute");
		try {
			const { config, session, direct } = setup(root);
			config.planning.engine = "cairn";
			config.executionMode = resolveExecutionMode({ mode: "direct" });
			const binding = attachProgressivePlanningController(session, { config, cwd: root });
			await session.prompt("plain local task");
			expect(direct).toHaveBeenCalledOnce();
			expect(execute).not.toHaveBeenCalled();
			expect(existsSync(join(config.stateDir, "planning.sqlite"))).toBe(false);
			binding.close();
		} finally {
			execute.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("routes Cairn outside the progressive Store and Controller while retaining the same live capacity binding", async () => {
		const root = mkdtempSync(join(tmpdir(), "cairn-routing-"));
		const factory = vi.fn();
		const execute = vi.spyOn(CairnPlanningEngine.prototype, "execute").mockResolvedValue({
			engine: "cairn",
			runId: "planning_cairn_" + "a".repeat(32),
			status: "idle",
			graph: { challengeId: "fixture", facts: [], hints: [], intents: [] },
		});
		try {
			const { config, session, custom, direct } = setup(root);
			config.planning.engine = "cairn";
			config.executionMode = resolveExecutionMode({ mode: "plan_multi", capacity: 2 });
			const binding = attachProgressivePlanningController(session, {
				config,
				cwd: root,
				controllerFactory: factory,
			});
			expect(binding.setExecutionCapacity(3)).toBe(3);
			await session.prompt("local orchestration");
			expect(execute).toHaveBeenCalledOnce();
			expect(factory).not.toHaveBeenCalled();
			expect(direct).not.toHaveBeenCalled();
			expect(custom).toHaveBeenCalledWith(expect.objectContaining({ customType: "cairn-planning-result" }), {
				triggerTurn: false,
			});
			expect(existsSync(join(config.stateDir, "planning.sqlite"))).toBe(false);
			binding.close();
		} finally {
			execute.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("does not select the new engine from unrelated configuration fields", () => {
		const root = mkdtempSync(join(tmpdir(), "cairn-config-"));
		try {
			const { config } = setup(root);
			mkdirSync(config.stateDir, { recursive: true });
			writeFileSync(
				join(config.stateDir, "desktop-config.json"),
				JSON.stringify({ planning: { engine: "cairn", mode: "active" } }),
			);
			const loaded = loadSecHeurConfig({
				projectRoot: root,
				stateDir: config.stateDir,
				legacyRoot: config.legacyRoot,
				env: {},
			});
			expect(loaded.planning.engine).toBe("cairn");
			expect(loaded.executionMode.mode).toBe("plan_single");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
