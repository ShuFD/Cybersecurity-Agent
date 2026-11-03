import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { buildReasonContext } from "../src/planning/cairn/reason-context-builder.ts";
import { buildReasonPrompt } from "../src/planning/cairn/reason-prompt.ts";
import {
	parseReasonProposal,
	REASON_PROPOSAL_LIMITS,
	validateReasonProposal,
} from "../src/planning/cairn/reason-proposal.ts";
import {
	buildCairnSubmissionBoard,
	cairnProposalSchema,
	cairnSelectionCatalog,
	cairnSubmissionRepairError,
	normalizeCairnSubmission,
	validateCairnSubmission,
} from "../src/planning/cairn/submission-contract.ts";
import type { ChallengeGraphSnapshot, GraphIntent } from "../src/planning/cairn/types.ts";
import { runProposalSession } from "../src/planning/proposal-session.ts";

const now = "2026-10-15T00:00:00Z";
const owner: GraphIntent = {
	id: "owner-1",
	challengeId: "run-1",
	fromFactIds: [],
	sourceHintIds: [],
	objective: "Synthetic existing work",
	scope: "local",
	capabilityTags: [],
	priority: 0,
	status: "running",
	resultFactIds: [],
	attemptCount: 1,
	version: 1,
	createdBy: "host",
	sourceIdeaIds: [],
	fingerprint: "owner-1",
	createdAt: now,
	updatedAt: now,
};
const graph: ChallengeGraphSnapshot = { challengeId: "run-1", facts: [], hints: [], intents: [owner] };
const evidence = ["original-observation-1"];
const intent = {
	objective: "Inspect one missing observation",
	successCriteria: ["Record its availability"],
	rationale: "A bounded missing input",
	fromFactIds: [],
	increment: "Resolve the remaining specific input",
	incrementEvidenceIds: evidence,
};
const proposal = () => ({
	rationaleSummary: "Preserve current owner",
	proposedIntents: [{ ...intent }],
	supersedeRecommendations: [],
});
const waiting = () => ({
	rationaleSummary: "Current owner covers the question",
	proposedIntents: [],
	supersedeRecommendations: [],
	coverage: {
		remaining: [{ question: "Remaining input", ownerId: "owner-1", evidenceIds: evidence }],
		recheckOn: "Owner checkpoint",
	},
});

it("accepts omitted waiting metadata by tracking existing live owners without changing the draft", () => {
	const input = { rationaleSummary: "Keep current execution", proposedIntents: [], supersedeRecommendations: [] };
	const normalized = normalizeCairnSubmission(input, graph, evidence);
	expect(() => validateCairnSubmission(normalized, graph, evidence)).not.toThrow();
	expect(normalized).toMatchObject({ coverage: { remaining: [{ dependsOn: [owner.id] }] } });
	expect(input).not.toHaveProperty("coverage");
	expect(graph.intents[0]).toEqual(owner);
});

it("fills only missing waiting owners, retains evidence and still rejects waiting with no live executor", () => {
	const input = {
		...waiting(),
		coverage: { remaining: [{ question: "Existing work", evidenceIds: evidence }], recheckOn: "checkpoint" },
	};
	const normalized = normalizeCairnSubmission(input, graph, evidence);
	expect(normalized).toMatchObject({ coverage: { remaining: [{ evidenceIds: evidence, dependsOn: [owner.id] }] } });
	expect(() => validateCairnSubmission(normalized, graph, evidence)).not.toThrow();
	const ended = { ...graph, intents: [{ ...owner, status: "concluded" as const }] };
	expect(() => validateCairnSubmission(normalized, ended, evidence)).toThrow("Waiting must name");
});

it("does not require a second explanation of new work in increment", () => {
	const { increment: _increment, ...newIntent } = intent;
	const normalized = normalizeCairnSubmission({ ...proposal(), proposedIntents: [newIntent] }, graph, evidence);
	expect(() => validateCairnSubmission(normalized, graph, evidence)).not.toThrow();
});

it("reconstructs the 20 recorded Cairn rejection conditions using their recorded live-owner catalogs", () => {
	// Original rejected tool arguments are not in this fixture. Only diagnostic
	// and live-owner metadata are real; proposal text is deliberately synthetic.
	const records = JSON.parse(
		readFileSync(join(import.meta.dirname, "fixtures/submission-rejection-audit-20261018.json"), "utf8"),
	) as Array<{
		mode: string;
		diagnostic: string;
		liveOwnerIds: string[];
	}>;
	let accepted = 0;
	let retained = 0;
	for (const record of records.filter((entry) => entry.mode === "cairn")) {
		const current = { ...graph, intents: record.liveOwnerIds.map((id) => ({ ...owner, id })) };
		if (record.diagnostic.startsWith("Explain the substantive increment")) {
			const { increment: _increment, ...next } = intent;
			const ended = { ...graph, intents: [{ ...owner, status: "concluded" as const }] };
			expect(() =>
				validateCairnSubmission(
					normalizeCairnSubmission({ ...proposal(), proposedIntents: [next] }, ended, evidence),
					ended,
					evidence,
				),
			).not.toThrow();
			accepted++;
			continue;
		}
		const input = {
			...waiting(),
			coverage: { remaining: [{ question: "Synthetic remaining question" }], recheckOn: "checkpoint" },
		};
		const normalized = normalizeCairnSubmission(input, current, evidence);
		if (record.liveOwnerIds.length) {
			expect(() => validateCairnSubmission(normalized, current, evidence)).not.toThrow();
			accepted++;
		} else {
			expect(() => validateCairnSubmission(normalized, current, evidence)).toThrow("Waiting must name");
			retained++;
		}
	}
	expect({ accepted, retained }).toEqual({ accepted: 19, retained: 1 });
});

it("shares host field limits without inflating rationale during host normalization", () => {
	const input = proposal();
	input.proposedIntents[0].rationale = "r".repeat(REASON_PROPOSAL_LIMITS.rationale);
	input.proposedIntents[0].increment = "i".repeat(REASON_PROPOSAL_LIMITS.rationale);
	expect(Check(cairnProposalSchema, input)).toBe(true);
	const normalized = normalizeCairnSubmission(input, graph, evidence);
	expect(validateReasonProposal(parseReasonProposal(JSON.stringify(normalized)), graph)).toEqual([]);
	expect(normalized).toMatchObject({
		proposedIntents: [
			{
				rationale: input.proposedIntents[0].rationale,
				increment: input.proposedIntents[0].increment,
				incrementEvidenceIds: evidence,
			},
		],
	});
	expect(input.proposedIntents[0]).not.toHaveProperty("clientId");
});

it.each(["objective", "rationale", "rationaleSummary", "successCriterion"])(
	"rejects %s at both the published and host contract boundaries",
	(field) => {
		const input = proposal();
		if (field === "rationaleSummary")
			input.rationaleSummary = "x".repeat(REASON_PROPOSAL_LIMITS.rationaleSummary + 1);
		else if (field === "successCriterion")
			input.proposedIntents[0].successCriteria = ["x".repeat(REASON_PROPOSAL_LIMITS.successCriterion + 1)];
		else
			input.proposedIntents[0][field as "objective" | "rationale"] = "x".repeat(
				REASON_PROPOSAL_LIMITS[field as "objective" | "rationale"] + 1,
			);
		expect(Check(cairnProposalSchema, input)).toBe(false);
		expect(() =>
			validateCairnSubmission(normalizeCairnSubmission(input, graph, evidence), graph, evidence),
		).toThrow();
	},
);

it("retains strict reference namespaces and checks owner state at submission time", () => {
	const invalid = proposal();
	invalid.proposedIntents[0].incrementEvidenceIds = ["foreign-observation"];
	expect(() => normalizeCairnSubmission(invalid, graph, evidence)).toThrow(
		"Increment evidence must cite exact original observations in this run",
	);
	const wait = waiting();
	wait.coverage.remaining[0].evidenceIds = ["foreign-observation"];
	expect(() => validateCairnSubmission(wait, graph, evidence)).toThrow("Coverage cites evidence outside this run");
	expect(() =>
		validateCairnSubmission(waiting(), { ...graph, intents: [{ ...owner, status: "concluded" }] }, evidence),
	).toThrow("Waiting must name a current owner");
	expect(() => validateCairnSubmission(waiting(), graph, evidence)).not.toThrow();
	expect(graph.intents[0]).toEqual(owner);
});

it("provides bounded original IDs separately from owner and fact namespaces", () => {
	const ids = Array.from({ length: 50 }, (_, i) => `observation-${i}`);
	const catalog = cairnSelectionCatalog(graph, ids);
	expect(catalog.incrementEvidenceIdsOrCoverageEvidenceIds.ids).toHaveLength(32);
	expect(catalog.incrementEvidenceIdsOrCoverageEvidenceIds.omittedCount).toBe(18);
	expect(catalog.coverageOwnerIdOrDependsOn.ids).toEqual(["owner-1"]);
	expect(catalog.fromFactIds.ids).toEqual([]);
	expect(cairnSelectionCatalog({ ...graph, intents: [] }, ids).waitingAllowed).toBe(false);
});

it("replays all 27 recorded rejection metadata with actionable local repair and current IDs", () => {
	const records = JSON.parse(
		readFileSync(join(import.meta.dirname, "fixtures/cairn-submission-rejections-metadata.json"), "utf8"),
	) as Array<{ error: string; target: string }>;
	expect(records).toHaveLength(27);
	expect(records.filter((r) => r.target === "sop")).toHaveLength(9);
	for (const record of records) {
		const error = cairnSubmissionRepairError(new Error(record.error), graph, evidence);
		expect(error.message).toContain(record.error);
		expect(error.message).toContain("Correct only the invalid fields");
		expect(error.message).toContain(evidence[0]);
	}
});

it("repairs an invalid citation in the same Pi session and persists valid draft fields without stopping the owner", async () => {
	const root = mkdtempSync(join(tmpdir(), "cairn-contract-"));
	const faux = fauxProvider({ models: [{ id: "contract-replay", reasoning: false }] });
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "fixture" }));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	const config = loadSecHeurConfig({
		projectRoot: root,
		stateDir: join(root, "state"),
		legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
		env: { PI_OFFLINE: "1" },
	});
	config.skillPaths = [];
	config.systemPromptPath = "";
	const invalid = proposal();
	invalid.proposedIntents[0].incrementEvidenceIds = ["foreign-observation"];
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("submit_planning_proposal", invalid), { stopReason: "toolUse" }),
		(context) => {
			expect(JSON.stringify(context.messages)).toContain("Correct only the invalid fields");
			expect(JSON.stringify(context.messages)).toContain(evidence[0]);
			return fauxAssistantMessage(fauxToolCall("submit_planning_proposal", proposal()), { stopReason: "toolUse" });
		},
	]);
	try {
		const result = await runProposalSession({
			config,
			cwd: root,
			task: "Repair the synthetic bounded proposal",
			model: faux.getModel(),
			modelRuntime: runtime,
			thinkingLevel: "off",
			queryPolicy: "board_only",
			outputSchema: cairnProposalSchema,
			readonlyContext: { run: { runId: graph.challengeId } },
			compactBoardContext: { selectionCatalog: cairnSelectionCatalog(graph, evidence) },
			normalizeSubmission: (v) => normalizeCairnSubmission(v, graph, evidence),
			validateSubmission: (v) => validateCairnSubmission(v, graph, evidence),
		});
		const staged = JSON.parse(result.finalText);
		expect(staged.proposedIntents[0]).toMatchObject(intent);
		expect(graph.intents[0]).toEqual(owner);
		expect(faux.state.callCount).toBe(2);
		const dir = join(config.stateDir, "planning", "proposal-submissions");
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(dir, files[0]), "utf8"))).toMatchObject({
			state: "validated_staged",
			value: { proposedIntents: [{ increment: intent.increment, incrementEvidenceIds: evidence }] },
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("keeps early active and Observer references plus exact source pointers in the production prompt and compact board", () => {
	const earlyFact = {
		id: "active-early",
		challengeId: "run-1",
		kind: "fact" as const,
		statement: "The existing delivery establishes a bounded local input",
		evidenceRefs: ["observation-0"],
		sourceMemoryIds: [],
		fingerprint: "early",
		status: "active" as const,
		observedAt: now,
		createdAt: now,
	};
	const activeGraph = { ...graph, facts: [earlyFact], intents: [{ ...owner, fromFactIds: [earlyFact.id] }] };
	const observations = Array.from({ length: 50 }, (_, i) => ({
		evidenceId: `observation-${i}`,
		intentId: owner.id,
		isError: false,
	}));
	const notes = [
		{
			topic: "pending-input",
			kind: "question" as const,
			text: "Check the saved input boundary",
			evidenceIds: ["observation-1"],
		},
	];
	const binding = {
		bindingId: "source-early",
		runId: "run-1",
		evidenceId: "observation-0",
		jsonPointer: "/result/version",
		sourceHash: "original-hash",
		value: "v1",
		authority: "original_observation" as const,
		outcome: "observation" as const,
	};
	const board = buildCairnSubmissionBoard(activeGraph, observations, notes, [
		binding,
		{ ...binding, bindingId: "source-large", value: { large: "x".repeat(1000) } },
	]);
	const prompt = buildReasonPrompt(buildReasonContext(activeGraph, [], 0));
	expect(prompt.text).toContain(earlyFact.id);
	expect(prompt.text).toContain(owner.id);
	expect(board.selectionCatalog.incrementEvidenceIdsOrCoverageEvidenceIds.ids).toContain("observation-0");
	expect(board.selectionCatalog.incrementEvidenceIdsOrCoverageEvidenceIds.ids).toContain("observation-1");
	expect(board.selectionCatalog.coverageOwnerIdOrDependsOn.ids).toContain(owner.id);
	expect(board.selectionCatalog.incrementEvidenceIdsOrCoverageEvidenceIds.omittedCount).toBe(18);
	expect(board.selectionCatalog.incrementEvidenceIdsOrCoverageEvidenceIds.omittedRelevantCount).toBe(0);
	expect(board.observerNotes).toEqual(notes);
	expect(board.sourceBindings.records[0]).toMatchObject({
		bindingId: "source-early",
		evidenceId: "observation-0",
		jsonPointer: "/result/version",
		sourceHash: "original-hash",
		value: "v1",
	});
	expect(board.sourceBindings.records[1]).toMatchObject({ valueOmitted: true });
	expect(board.sourceBindings.records[1]).not.toHaveProperty("value");
	expect(JSON.stringify(board)).not.toContain("x".repeat(1000));
});
