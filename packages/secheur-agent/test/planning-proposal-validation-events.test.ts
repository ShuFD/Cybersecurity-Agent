import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { artexObservationSchema } from "../src/planning/artex-adapters.ts";
import { ArtexInputError } from "../src/planning/artex-graph.ts";
import { planningFailure } from "../src/planning/failures.ts";
import { hypothesisObservationSchema } from "../src/planning/hypothesis-adapters.ts";
import { HypothesisInputError } from "../src/planning/hypothesis-graph.ts";
import { planningToolFailureMetadata, runProposalSession } from "../src/planning/proposal-session.ts";

const schema = Type.Object({
	decision: Type.Union([Type.Literal("create_tasks"), Type.Literal("blocked")]),
	tasks: Type.Array(
		Type.Object({ key: Type.String(), objective: Type.String(), dependsOn: Type.Array(Type.String()) }),
	),
});
const proposal = {
	decision: "create_tasks",
	tasks: [{ key: "task-1", objective: "PRIVATE_PROPOSAL_BODY", dependsOn: [] }],
};
const call = (name: string, args: Record<string, unknown>, id: string) =>
	fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "proposal-validation-"));
	const faux = fauxProvider({ models: [{ id: "validation-fixture", reasoning: false }] });
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "PRIVATE_CREDENTIAL" }));
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
	return {
		root,
		faux,
		events,
		options: {
			config,
			cwd: root,
			task: "PRIVATE_PROMPT: submit the synthetic proposal.",
			model: faux.getModel(),
			modelRuntime: runtime,
			thinkingLevel: "off" as const,
			outputSchema: schema,
			readonlyContext: { run: { runId: "synthetic-validation" } },
			validateSubmission: vi.fn(),
			onLifecycleEvent: (type: string, payload: Record<string, unknown> = {}) => events.push({ type, payload }),
		},
	};
}

it("counts a native schema rejection once and accepts the corrected proposal in the same Pi session", async () => {
	const { root, faux, events, options } = await fixture();
	faux.setResponses([
		call(
			"submit_planning_proposal",
			{
				...proposal,
				decision: "PRIVATE_INVALID_ENUM",
				tasks: [{ objective: "PRIVATE_PROPOSAL_BODY", dependsOn: { credential: "PRIVATE_CREDENTIAL" } }],
			},
			"native-invalid",
		),
		(context) => {
			const previous = context.messages.filter((message) => message.role === "toolResult");
			expect(previous).toHaveLength(1);
			expect(previous[0]).toMatchObject({ toolCallId: "native-invalid", isError: true });
			return call("submit_planning_proposal", proposal, "corrected");
		},
	]);
	try {
		const result = await runProposalSession(options);
		expect(JSON.parse(result.finalText)).toEqual(proposal);
		expect(options.validateSubmission).toHaveBeenCalledTimes(1);
		expect(faux.state.callCount).toBe(2);
		const rejected = events.filter((event) => event.type === "planning_submission_rejected");
		expect(rejected).toHaveLength(1);
		expect(rejected[0].payload).toMatchObject({
			rejections: 0,
			nativeSchemaRejections: 1,
			source: "native_tool_validation",
			errorCode: "tool_schema_validation",
			fieldPaths: expect.arrayContaining(["decision", "tasks.0.key", "tasks.0.dependsOn.0"]),
			toolCallId: "native-invalid",
		});
		expect(rejected[0].payload.requestId).toEqual(
			events.find((event) => event.type === "planning_submission_staged")?.payload.requestId,
		);
		expect(events.find((event) => event.type === "planning_session_end")?.payload).toMatchObject({
			rejections: 0,
			nativeSchemaRejections: 1,
		});
		const diagnostics = JSON.stringify(events);
		for (const secret of ["PRIVATE_INVALID_ENUM", "PRIVATE_PROPOSAL_BODY", "PRIVATE_PROMPT", "PRIVATE_CREDENTIAL"])
			expect(diagnostics).not.toContain(secret);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("counts custom validation once and ignores errors from other tools", async () => {
	const { root, faux, events, options } = await fixture();
	options.validateSubmission.mockImplementationOnce(() => {
		throw planningFailure("proposal_validation", "proposal_validation_error", "Unsupported PRIVATE_VALIDATOR_VALUE");
	});
	faux.setResponses([
		call("planning_query_context", { section: { invalid: true } }, "unrelated-native-error"),
		call("planning_query_context", { section: "PRIVATE_UNKNOWN_SECTION" }, "unrelated-error"),
		call("submit_planning_proposal", proposal, "custom-invalid"),
		call("submit_planning_proposal", proposal, "custom-corrected"),
	]);
	try {
		expect(JSON.parse((await runProposalSession(options)).finalText)).toEqual(proposal);
		const rejected = events.filter((event) => event.type === "planning_submission_rejected");
		expect(rejected).toHaveLength(1);
		expect(rejected[0].payload).toMatchObject({
			rejections: 1,
			source: "submission_validation",
			errorCode: "proposal_validation_error",
			stage: "proposal_validation",
			toolCallId: "custom-invalid",
		});
		expect(events.find((event) => event.type === "planning_session_end")?.payload.rejections).toBe(1);
		expect(JSON.stringify(events)).not.toContain("PRIVATE_VALIDATOR_VALUE");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it.each([
	new ArtexInputError("artex_unknown_reference", "PRIVATE_BAD_REF", ["parentIds"]),
	new HypothesisInputError("hypothesis_unknown_evidence", "PRIVATE_BAD_REF", ["card.evidenceRefs"]),
])("keeps fixed typed input diagnostics while correcting in the same session: $code", async (error) => {
	const { root, faux, events, options } = await fixture();
	options.validateSubmission.mockImplementationOnce(() => {
		throw error;
	});
	faux.setResponses([
		call("submit_planning_proposal", proposal, "invalid-reference"),
		call("submit_planning_proposal", proposal, "corrected-reference"),
	]);
	try {
		expect(JSON.parse((await runProposalSession(options)).finalText)).toEqual(proposal);
		expect(events.find((event) => event.type === "planning_submission_rejected")?.payload).toMatchObject({
			errorCode: error.code,
			stage: "proposal_validation",
			fieldPaths: error.fieldPaths,
			rejections: 1,
		});
		expect(JSON.stringify(events)).not.toContain("PRIVATE_BAD_REF");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("records only fixed publication causes and trusted schema field paths", () => {
	const result = {
		content: [{ type: "text", text: "PRIVATE_TOOL_OUTPUT" }],
		details: {
			reasonCode: "artex_evidence_required",
			fieldPaths: ["evidenceRefs", "PRIVATE_MODEL_FIELD"],
			retryable: true,
		},
	};
	expect(planningToolFailureMetadata("artex_publish_observation", result, artexObservationSchema)).toEqual({
		reasonCode: "artex_evidence_required",
		diagnosticLayer: "tool_input",
		fieldPaths: ["evidenceRefs"],
	});
	expect(planningToolFailureMetadata("untrusted_external_tool", result, artexObservationSchema)).toEqual({});
	expect(
		planningToolFailureMetadata("artex_publish_observation", { details: { reasonCode: "PRIVATE_CODE" } }),
	).toEqual({});
	const native = {
		content: [
			{
				type: "text",
				text: 'Validation failed for tool "artex_publish_observation":\n  - payload: expected string\n  - PRIVATE_MODEL_FIELD: invalid\n\nReceived arguments:\nPRIVATE_ARGUMENTS',
			},
		],
	};
	expect(planningToolFailureMetadata("artex_publish_observation", native, artexObservationSchema)).toEqual({
		reasonCode: "tool_schema_validation",
		diagnosticLayer: "native_tool_validation",
		fieldPaths: ["payload"],
	});
	expect(
		planningToolFailureMetadata(
			"hypothesis_publish_observation",
			{
				details: {
					reasonCode: "hypothesis_unknown_evidence",
					fieldPaths: ["resolutions[].evidenceRefs", "PRIVATE_FIELD"],
				},
			},
			hypothesisObservationSchema,
		),
	).toMatchObject({ fieldPaths: ["resolutions[].evidenceRefs"] });
});

it("accepts a correction after two native schema errors in the same Pi session", async () => {
	const { root, faux, events, options } = await fixture();
	faux.setResponses([
		call("submit_planning_proposal", { ...proposal, decision: "invalid" }, "native-invalid-1"),
		call("submit_planning_proposal", { ...proposal, decision: "invalid" }, "native-invalid-2"),
		call("submit_planning_proposal", proposal, "corrected"),
	]);
	try {
		expect(JSON.parse((await runProposalSession(options)).finalText)).toEqual(proposal);
		expect(faux.state.callCount).toBe(3);
		expect(options.validateSubmission).toHaveBeenCalledTimes(1);
		expect(events.filter((event) => event.type === "planning_submission_rejected")).toHaveLength(2);
		expect(events.find((event) => event.type === "planning_session_end")?.payload).toMatchObject({
			rejections: 0,
			nativeSchemaRejections: 2,
		});
		expect(events.some((event) => event.type === "required_tool_recovery_start")).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("omits model-supplied field names and unrecognized typed codes from rejection diagnostics", async () => {
	const { root, faux, events, options } = await fixture();
	options.validateSubmission.mockImplementationOnce(() => {
		throw planningFailure("PRIVATE_STAGE", "PRIVATE_CODE", "PRIVATE_ERROR_BODY");
	});
	faux.setResponses([
		call(
			"submit_planning_proposal",
			{ ...proposal, decision: "PRIVATE_ENUM", extras: { PRIVATE_FIELD: { credential: "PRIVATE_VALUE" } } },
			"native-invalid",
		),
		call("submit_planning_proposal", proposal, "custom-invalid"),
		call("submit_planning_proposal", proposal, "corrected"),
	]);
	try {
		const result = await runProposalSession({
			...options,
			outputSchema: Type.Object({
				...schema.properties,
				extras: Type.Optional(Type.Record(Type.String(), Type.Integer())),
			}),
		});
		expect(JSON.parse(result.finalText)).toEqual(proposal);
		const rejected = events.filter((event) => event.type === "planning_submission_rejected");
		expect(rejected).toHaveLength(2);
		expect(rejected[0].payload.fieldPaths).toEqual(["decision"]);
		expect(rejected[1].payload).toMatchObject({ errorCode: "unclassified", stage: "unclassified" });
		for (const secret of [
			"PRIVATE_STAGE",
			"PRIVATE_CODE",
			"PRIVATE_ERROR_BODY",
			"PRIVATE_ENUM",
			"PRIVATE_FIELD",
			"PRIVATE_VALUE",
		])
			expect(JSON.stringify(events)).not.toContain(secret);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("does not combine native errors with the semantic rejection budget", async () => {
	const { root, faux, events, options } = await fixture();
	options.validateSubmission.mockImplementationOnce(() => {
		throw new Error("Synthetic invalid dependency reference");
	});
	faux.setResponses([
		call("submit_planning_proposal", { ...proposal, decision: "invalid" }, "native-invalid"),
		call("submit_planning_proposal", proposal, "custom-invalid"),
		call("submit_planning_proposal", proposal, "corrected"),
	]);
	try {
		expect(JSON.parse((await runProposalSession(options)).finalText)).toEqual(proposal);
		expect(faux.state.callCount).toBe(3);
		expect(
			events.filter((event) => event.type === "planning_submission_rejected").map((event) => event.payload),
		).toEqual([
			expect.objectContaining({ rejections: 0, nativeSchemaRejections: 1, source: "native_tool_validation" }),
			expect.objectContaining({ rejections: 1, source: "submission_validation", errorCode: "unclassified" }),
		]);
		expect(events.find((event) => event.type === "planning_session_end")?.payload).toMatchObject({
			rejections: 1,
			nativeSchemaRejections: 1,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("retains the existing two-semantic-rejection stop boundary", async () => {
	const { root, faux, events, options } = await fixture();
	options.validateSubmission.mockImplementation(() => {
		throw new Error("Synthetic invalid dependency reference");
	});
	faux.setResponses([
		call("submit_planning_proposal", proposal, "custom-invalid-1"),
		call("submit_planning_proposal", proposal, "custom-invalid-2"),
		call("submit_planning_proposal", proposal, "must-not-run"),
	]);
	try {
		await expect(runProposalSession(options)).rejects.toThrow("No validated structured proposal was staged");
		expect(faux.state.callCount).toBe(2);
		expect(options.validateSubmission).toHaveBeenCalledTimes(2);
		expect(events.find((event) => event.type === "planning_session_end")?.payload).toMatchObject({
			rejections: 2,
			nativeSchemaRejections: 0,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
