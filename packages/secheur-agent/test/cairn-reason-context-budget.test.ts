import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { buildReasonContext, REASON_CONTEXT_LIMITS } from "../src/planning/cairn/reason-context-builder.ts";
import type { ChallengeGraphSnapshot, GraphFact } from "../src/planning/cairn/types.ts";

const timestamp = "2026-10-17T00:00:00.000Z";

function goal(index: number): GraphFact {
	return {
		id: `goal-${index}`,
		challengeId: "budget",
		kind: "goal",
		statement: "observation ".repeat(200),
		evidenceRefs: [`evidence-${index}`],
		sourceMemoryIds: [],
		fingerprint: `original-${index}`,
		status: "active",
		observedAt: timestamp,
		createdAt: timestamp,
	};
}

// Bound the real synchronous call in another process: a regression must fail, not hang Vitest.
function boundedBuild(snapshot: ChallengeGraphSnapshot) {
	const moduleUrl = new URL("../src/planning/cairn/reason-context-builder.ts", import.meta.url).href;
	return spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
import { readFileSync } from "node:fs";
import { buildReasonContext } from ${JSON.stringify(moduleUrl)};
const snapshot = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(buildReasonContext(snapshot, [], 1)));
`,
		],
		{ input: JSON.stringify(snapshot), encoding: "utf8", timeout: 2_000 },
	);
}

describe("Cairn context budget progress", () => {
	test("terminates on many pinned long facts, retaining references and immutable source records", () => {
		const snapshot: ChallengeGraphSnapshot = {
			challengeId: "budget",
			facts: Array.from({ length: 40 }, (_, i) => goal(i)),
			hints: [],
			intents: [],
		};
		const before = JSON.stringify(snapshot);
		const child = boundedBuild(snapshot);
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		const result = buildReasonContext(snapshot, [], 1);
		expect(JSON.parse(child.stdout)).toEqual(result);
		expect(JSON.stringify(result.context).length).toBeLessThanOrEqual(REASON_CONTEXT_LIMITS.characters);
		expect(result.context.activeFacts.map((f) => f.id).sort()).toEqual(snapshot.facts.map((f) => f.id).sort());
		for (const item of result.context.activeFacts) {
			expect(item.evidenceRefs).toEqual(snapshot.facts.find((f) => f.id === item.id)?.evidenceRefs);
		}
		expect(result.context.truncated).toBe(true);
		expect(JSON.stringify(snapshot)).toBe(before);
		expect(buildReasonContext({ ...snapshot, facts: [...snapshot.facts].reverse() }, [], 1)).toEqual(result);
	});

	test("compresses live objectives and scopes without removing causal IDs or ownership", () => {
		const facts = Array.from({ length: 40 }, (_, i) => goal(i));
		const snapshot: ChallengeGraphSnapshot = {
			challengeId: "budget",
			facts,
			hints: [],
			intents: [
				{
					id: "live",
					challengeId: "budget",
					fromFactIds: facts.map((f) => f.id),
					sourceHintIds: [],
					objective: "objective ".repeat(1500),
					scope: "scope ".repeat(1500),
					capabilityTags: [],
					priority: 1,
					status: "running",
					ownerSolverId: "owner",
					resultFactIds: [],
					attemptCount: 1,
					version: 1,
					createdBy: "host",
					sourceIdeaIds: [],
					fingerprint: "original-intent",
					createdAt: timestamp,
					updatedAt: timestamp,
				},
			],
		};
		const before = JSON.stringify(snapshot);
		const child = boundedBuild(snapshot);
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		const result = buildReasonContext(snapshot, [], 1);
		expect(JSON.stringify(result.context).length).toBeLessThanOrEqual(REASON_CONTEXT_LIMITS.characters);
		expect(result.context.activeIntents[0]).toMatchObject({
			id: "live",
			ownerSolverId: "owner",
			fromFactIds: facts.map((f) => f.id),
		});
		expect(result.context.activeIntents[0].scope).toContain("[overview shortened]");
		expect(JSON.stringify(snapshot)).toBe(before);
	});

	test("fails promptly for irreducible reference overflow without dropping evidence", () => {
		const snapshot: ChallengeGraphSnapshot = {
			challengeId: "budget",
			facts: [{ ...goal(0), evidenceRefs: ["reference".repeat(4000)] }],
			hints: [],
			intents: [],
		};
		const child = boundedBuild(snapshot);
		expect(child.error).toBeUndefined();
		expect(child.status).toBe(1);
		expect(child.stderr).toContain("causal identifiers exceed overview budget");
	});
});
