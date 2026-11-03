import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PlanningSourceBindings } from "../src/planning/source-bindings.ts";

it("keeps literal parameter values tied to their original run and source version", () => {
	const root = mkdtempSync(join(tmpdir(), "bound-source-"));
	let hash = "original";
	const read = (evidenceId: string) => ({ runId: evidenceId === "foreign" ? "other" : "run", evidenceId, sourceHash: hash, outcome: "observation" as const, value: { key: "a".repeat(32), version: "v1" } });
	const store = new PlanningSourceBindings(root, "run", read);
	try {
		const binding = store.bind("proof", "/key");
		const wrong = JSON.stringify({ bindingId: binding.bindingId, value: "a".repeat(31) });
		const right = JSON.stringify({ bindingId: binding.bindingId, value: "a".repeat(32) });
		expect(store.provesCorrection(wrong, right, ["proof"])).toBe(true);
		expect(store.provesCorrection("The route does not work", right, ["proof"])).toBe(false);
		expect(store.provesCorrection(wrong, right, ["foreign"])).toBe(false);
		expect(() => store.bind("foreign", "/key")).toThrow("another run");
		expect(() => store.bind("proof", "/__proto__")).toThrow("does not exist");
		const restored = new PlanningSourceBindings(root, "run", read); expect(restored.list()).toEqual([binding]);
		hash = "changed"; expect(store.provesCorrection(wrong, right, ["proof"])).toBe(false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
it("keeps execution failure distinct from evidence against a hypothesis", () => {
	const root = mkdtempSync(join(tmpdir(), "failed-source-"));
	try {
		const store = new PlanningSourceBindings(root, "run", evidenceId => ({ runId: "run", evidenceId, sourceHash: "error", outcome: "tool_error", value: { error: "local parser failed" } }));
		const binding = store.bind("proof", "/error");
		expect(binding.outcome).toBe("tool_error");
		expect(store.provesCorrection(JSON.stringify({ bindingId: binding.bindingId, value: "hypothesis disproved" }), JSON.stringify({ bindingId: binding.bindingId, value: "local parser failed" }), ["proof"])).toBe(false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
