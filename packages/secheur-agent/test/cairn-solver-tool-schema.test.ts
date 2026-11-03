import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { createGraphTools } from "../src/planning/cairn/solver-tools.ts";

it("exports provider-compatible object schemas without weakening Intent conclusion validation", async () => {
	const tools: Array<{ name: string; parameters: TSchema }> = [];
	const extension = createGraphTools(async () => {
		throw new Error("Schema inspection must not execute graph operations");
	});
	if (typeof extension === "function") throw new Error("Expected graph extension factory");
	await extension.factory({
		registerTool: (tool: { name: string; parameters: TSchema }) => tools.push(tool),
	} as unknown as ExtensionAPI);
	expect(tools).toHaveLength(8);
	for (const tool of tools)
		expect(JSON.parse(JSON.stringify(tool.parameters)), tool.name).toMatchObject({ type: "object" });
	const schema = tools.find((tool) => tool.name === "conclude_intent")?.parameters;
	if (!schema) throw new Error("Missing conclusion tool");
	for (const outcome of ["success", "partial", "failure", "inconclusive"])
		expect(
			Value.Check(schema, {
				outcome,
				facts: [{ kind: "fact", statement: "observed", evidenceRefs: ["ev-1"] }],
				factIds: [],
				artifactIds: [],
			}),
		).toBe(true);
	expect(Value.Check(schema, { outcome: "success" })).toBe(true);
	for (const invalid of [
		{},
		{ outcome: "invented" },
		{ outcome: "success", facts: "invalid" },
		{ outcome: "success", factIds: [42] },
	])
		expect(Value.Check(schema, invalid)).toBe(false);
});
