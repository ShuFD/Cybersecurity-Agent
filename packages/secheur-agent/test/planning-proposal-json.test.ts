import { describe, expect, it } from "vitest";
import { parseProposalJson } from "../src/planning/proposal-json.ts";

describe("Proposal wrapper boundary", () => {
	it.each([' {"ok":true} ', '```json\n{"ok":true}\n```', '```\n{"ok":true}\n```'])(
		"accepts one complete document: %s",
		(text) => {
			expect(parseProposalJson(text)).toEqual({ ok: true });
		},
	);
	it.each([
		'{"ok":true',
		'{"ok":true}{"ok":false}',
		'```json\n{"ok":true}\n```\n```json\n{}\n```',
		'Here is the plan: {"ok":true}',
	])("rejects incomplete or ambiguous data: %s", (text) => {
		expect(() => parseProposalJson(text)).toThrow();
	});
});
