import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { parsePlanningPlanProposal } from "../src/planning/contracts.ts";
import { planningProposalSchema } from "../src/planning/proposal-schema.ts";
import { fillHostPlanningFields, runProposalSession } from "../src/planning/proposal-session.ts";

it("queries only request records, repairs citations in the same Pi conversation and persists before acknowledgment", async () => {
	const root = mkdtempSync(join(tmpdir(), "planning-session-"));
	const faux = fauxProvider({ models: [{ id: "planning-fixture", reasoning: false }] });
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
	const call = (name: string, args: Record<string, unknown>, id: string) =>
		fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
	faux.setResponses([
		call("planning_query_context", { section: "evidence", id: "same-run-proof" }, "query"),
		call("submit_planning_proposal", { evidenceId: "other-run-proof" }, "bad"),
		call("submit_planning_proposal", { evidenceId: "same-run-proof" }, "good"),
	]);
	try {
		const result = await runProposalSession({
			config,
			cwd: root,
			task: "Read the synthetic evidence and cite it.",
			model: faux.getModel(),
			modelRuntime: runtime,
			thinkingLevel: "off",
			outputSchema: Type.Object({ evidenceId: Type.String() }),
			readonlyContext: {
				run: { runId: "synthetic" },
				evidence: [{ evidenceId: "same-run-proof", content: "synthetic observation" }],
			},
			validateSubmission(value) {
				if ((value as { evidenceId: string }).evidenceId !== "same-run-proof")
					throw new Error("Reference not in this run");
			},
		});
		expect(JSON.parse(result.finalText)).toEqual({ evidenceId: "same-run-proof" });
		expect(faux.state.callCount).toBe(3);
		const directory = join(config.stateDir, "planning", "proposal-submissions");
		const files = readdirSync(directory);
		expect(files).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(directory, files[0]), "utf8"))).toMatchObject({
			state: "validated_staged",
			run: { runId: "synthetic" },
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("fills administrative fields without promoting a model claim into a fact", () => {
	const value = {
		proposedIntents: [
			{ objective: "Inspect one synthetic observation", fromFactIds: ["claim-1"], capabilityTags: ["invented"] },
		],
	};
	expect(fillHostPlanningFields(value)).toMatchObject({
		proposedIntents: [{ clientId: "intent-1", priority: 0, capabilityTags: [], fromFactIds: ["claim-1"] }],
	});
	expect(value.proposedIntents[0].capabilityTags).toEqual(["invented"]);
});

it("replays a recorded failproof proposal through board-only Pi submission without query tools", async () => {
	const fixture = JSON.parse(
		readFileSync(join(import.meta.dirname, "fixtures/focused-failproof-proposal.json"), "utf8"),
	);
	const root = mkdtempSync(join(tmpdir(), "board-replay-"));
	const faux = fauxProvider({ models: [{ id: "recorded-planning", reasoning: false }] });
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
	const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
	faux.setResponses([
		(context) => {
			expect(context.tools?.map((tool) => tool.name)).toEqual(["submit_planning_proposal"]);
			return fauxAssistantMessage(fauxToolCall("submit_planning_proposal", fixture.proposal), {
				stopReason: "toolUse",
			});
		},
	]);
	try {
		const result = await runProposalSession({
			config,
			cwd: root,
			task: "Select useful next work from the reconstructed historical board.",
			model: faux.getModel(),
			modelRuntime: runtime,
			thinkingLevel: "off",
			queryPolicy: "board_only",
			outputSchema: planningProposalSchema,
			readonlyContext: { run: fixture.run },
			validateSubmission: (value) => {
				parsePlanningPlanProposal(JSON.stringify(value), fixture.proposal.expectedRevision);
			},
			onLifecycleEvent: (type, payload = {}) => events.push({ type, payload }),
		});
		expect(JSON.parse(result.finalText)).toEqual(fixture.proposal);
		expect(faux.state.callCount).toBe(1);
		const started = events.find((e) => e.type === "tool_execution_start");
		const ended = events.find((e) => e.type === "tool_execution_end");
		expect(started?.payload.toolName).toBe("submit_planning_proposal");
		expect(ended?.payload.toolName).toBe("submit_planning_proposal");
		expect(started?.payload.requestId).toBe(ended?.payload.requestId);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("submits from one graph plus an intact selection catalog without duplicate planner instructions", async () => {
	const root = mkdtempSync(join(tmpdir(), "compact-board-"));
	const faux = fauxProvider({ models: [{ id: "compact-planner", reasoning: false }] });
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
	const catalog = Array.from({ length: 24 }, (_, i) => `evidence-${i}-` + "x".repeat(48));
	const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
	faux.setResponses([
		(context) => {
			expect((context.systemPrompt ?? "").split("You are the planner.").length - 1).toBe(1);
			const input = JSON.stringify(context.messages);
			expect(input.split("AUTHORITATIVE_GRAPH_ONCE").length - 1).toBe(1);
			expect(input).not.toContain("DUPLICATE_GRAPH_NOT_FOR_CONTEXT");
			for (const id of catalog) expect(input).toContain(id);
			expect(context.tools?.map((tool) => tool.name)).toEqual(["submit_planning_proposal"]);
			return fauxAssistantMessage(fauxToolCall("submit_planning_proposal", { evidenceId: catalog[23] }), {
				stopReason: "toolUse",
			});
		},
	]);
	try {
		await runProposalSession({
			config,
			cwd: root,
			task: "AUTHORITATIVE_GRAPH_ONCE",
			model: faux.getModel(),
			modelRuntime: runtime,
			thinkingLevel: "off",
			queryPolicy: "board_only",
			readonlyContext: { run: { runId: "compact" }, graph: "DUPLICATE_GRAPH_NOT_FOR_CONTEXT" },
			compactBoardContext: { selectionCatalog: { evidenceIds: catalog } },
			outputSchema: Type.Object({ evidenceId: Type.String() }),
			validateSubmission: (value) => {
				expect((value as { evidenceId: string }).evidenceId).toBe(catalog[23]);
			},
			onLifecycleEvent: (type, payload = {}) => events.push({ type, payload }),
		});
		expect(faux.state.callCount).toBe(1);
		expect(events.filter((e) => e.type === "planning_session_end")).toHaveLength(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
