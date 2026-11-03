import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { REASON_PROPOSAL_LIMITS } from "../src/planning/cairn/reason-proposal.ts";
import { cairnProposalSchema } from "../src/planning/proposal-schema.ts";

it.each(["progressive", "cairn"])("loads the frozen rollback profile for %s without auxiliary planning", (engine) => {
	const root = mkdtempSync(join(tmpdir(), "rollback-profile-"));
	try {
		const stateDir = join(root, "state");
		mkdirSync(stateDir);
		const profile = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../rollback-profile.json"), "utf8"));
		profile.planning.engine = engine;
		writeFileSync(join(stateDir, "desktop-config.json"), JSON.stringify(profile));
		const config = loadSecHeurConfig({ projectRoot: root, stateDir, legacyRoot: join(root, "legacy"), env: {} });
		expect(config.executionMode).toMatchObject({ mode: "plan_multi", capacity: 2 });
		expect(config.planning).toMatchObject({
			engine,
			observerMode: "off",
			taskGranularityPromptEnabled: false,
			evidenceCatalogEnabled: false,
		});
		expect(config.planning.globalExecutorCapacity).toBeUndefined();
		expect(config.maxTurns).toBe(220);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("advertises Cairn host limits with optional coverage and no required continuity contract", () => {
	expect(cairnProposalSchema.properties.proposedIntents.items.properties.objective).toMatchObject({
		maxLength: REASON_PROPOSAL_LIMITS.objective,
	});
	expect(cairnProposalSchema.properties.proposedIntents.items.properties.successCriteria.items).toMatchObject({
		maxLength: REASON_PROPOSAL_LIMITS.successCriterion,
	});
	expect(Object.keys(cairnProposalSchema.properties).sort()).toEqual([
		"coverage",
		"proposedIntents",
		"rationaleSummary",
		"supersedeRecommendations",
	]);
	expect(cairnProposalSchema.required).not.toContain("coverage");
});
