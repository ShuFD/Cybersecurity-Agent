import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";
import { FOCUSED_CONTEXT_MAX_LIMITS } from "./context-builder.ts";

const timestamp = Type.Optional(Type.String());
const factKind = Type.Union([
	Type.Literal("origin"),
	Type.Literal("goal"),
	Type.Literal("fact"),
	Type.Literal("evidence"),
	Type.Literal("failure_boundary"),
	Type.Literal("credential"),
	Type.Literal("asset"),
	Type.Literal("flag"),
	Type.Literal("constraint"),
]);

const contextParams = Type.Object({
	afterSequence: Type.Optional(Type.Integer({ minimum: 0 })),
	maxFacts: Type.Optional(Type.Integer({ minimum: 0, maximum: FOCUSED_CONTEXT_MAX_LIMITS.maxFacts })),
	maxHints: Type.Optional(Type.Integer({ minimum: 0, maximum: FOCUSED_CONTEXT_MAX_LIMITS.maxHints })),
	maxIntents: Type.Optional(Type.Integer({ minimum: 0, maximum: FOCUSED_CONTEXT_MAX_LIMITS.maxIntents })),
	maxEvents: Type.Optional(Type.Integer({ minimum: 0, maximum: FOCUSED_CONTEXT_MAX_LIMITS.maxEvents })),
	maxTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: FOCUSED_CONTEXT_MAX_LIMITS.maxTokens })),
	maxCharacters: Type.Optional(Type.Integer({ minimum: 0, maximum: FOCUSED_CONTEXT_MAX_LIMITS.maxCharacters })),
});
const factParams = Type.Object({
	createdAt: timestamp,
	kind: factKind,
	statement: Type.String({ minLength: 1 }),
	confidence: Type.Number({ minimum: 0, maximum: 1 }),
	evidenceRefs: Type.Optional(Type.Array(Type.String())),
	sourceEventIds: Type.Optional(Type.Array(Type.String())),
});
const intentParams = Type.Object({
	createdAt: timestamp,
	objective: Type.String({ minLength: 1 }),
	scope: Type.String({ minLength: 1 }),
	confidence: Type.Number({ minimum: 0, maximum: 1 }),
	fromFactIds: Type.Optional(Type.Array(Type.String())),
	sourceHintIds: Type.Optional(Type.Array(Type.String())),
	capabilityTags: Type.Optional(Type.Array(Type.String())),
	sourceEventIds: Type.Optional(Type.Array(Type.String())),
});
const evidenceParams = Type.Object({
	createdAt: timestamp,
	factId: Type.String({ minLength: 1 }),
	evidenceRef: Type.String({ minLength: 1 }),
});
const artifactParams = Type.Object({
	createdAt: timestamp,
	relativePath: Type.String({ minLength: 1 }),
	sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	size: Type.Integer({ minimum: 0 }),
	mimeType: Type.String({ minLength: 1 }),
	intentId: Type.Optional(Type.String()),
});
const resultFact = Type.Object({
	kind: factKind,
	statement: Type.String({ minLength: 1 }),
	evidenceRefs: Type.Optional(Type.Array(Type.String())),
});
const checkpointParams = Type.Object({
	facts: Type.Optional(Type.Array(resultFact)),
	factIds: Type.Optional(Type.Array(Type.String())),
	artifactIds: Type.Optional(Type.Array(Type.String())),
});
const concludeParams = Type.Object({
	...checkpointParams.properties,
	outcome: Type.Union([
		Type.Literal("success"),
		Type.Literal("partial"),
		Type.Literal("failure"),
		Type.Literal("inconclusive"),
	]),
});

function result(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

export function createGraphTools(
	requestHostBridge: (action: string, params: unknown, toolCallId: string) => Promise<unknown>,
): InlineExtension {
	return {
		name: "cairn-graph",
		hidden: true,
		factory(pi) {
			const graphSolverTools = [
				defineTool({
					name: "graph_get_context",
					label: "Graph Context",
					description: "Read bounded active Graph context for the current challenge.",
					parameters: contextParams,
					async execute(toolCallId, params: Static<typeof contextParams>) {
						return result(await requestHostBridge("graph_get_context", params, toolCallId));
					},
				}),
				defineTool({
					name: "fact_propose",
					label: "Propose Fact",
					description: "Submit an unconfirmed Fact candidate.",
					parameters: factParams,
					async execute(toolCallId, params: Static<typeof factParams>) {
						return result(await requestHostBridge("fact_propose", params, toolCallId));
					},
				}),
				defineTool({
					name: "intent_propose",
					label: "Propose Intent",
					description: "Submit an unconfirmed Intent candidate.",
					parameters: intentParams,
					async execute(toolCallId, params: Static<typeof intentParams>) {
						return result(await requestHostBridge("intent_propose", params, toolCallId));
					},
				}),
				defineTool({
					name: "fact_append_evidence",
					label: "Append Fact Evidence",
					description: "Append one evidence reference to an existing Fact.",
					parameters: evidenceParams,
					async execute(toolCallId, params: Static<typeof evidenceParams>) {
						return result(await requestHostBridge("fact_append_evidence", params, toolCallId));
					},
				}),
				defineTool({
					name: "artifact_register",
					label: "Register Artifact",
					description: "Ask the Host to copy and register a file from the current Solver workspace.",
					parameters: artifactParams,
					async execute(toolCallId, params: Static<typeof artifactParams>) {
						return result(await requestHostBridge("artifact_register", params, toolCallId));
					},
				}),
				defineTool({
					name: "checkpoint_intent",
					label: "Checkpoint Intent",
					description: "Atomically save confirmed results while keeping the bound Intent running.",
					parameters: checkpointParams,
					async execute(toolCallId, params: Static<typeof checkpointParams>) {
						return result(await requestHostBridge("intent_checkpoint", params, toolCallId));
					},
				}),
				defineTool({
					name: "conclude_intent",
					label: "Conclude Intent",
					description: "Atomically submit final results and conclude the bound Intent.",
					parameters: concludeParams,
					async execute(toolCallId, params: Static<typeof concludeParams>) {
						return { ...result(await requestHostBridge("intent_conclude", params, toolCallId)), terminate: true };
					},
				}),
				defineTool({
					name: "release_intent",
					label: "Release Intent",
					description: "Release the current Intent without concluding it.",
					parameters: Type.Object({}),
					async execute(toolCallId) {
						return { ...result(await requestHostBridge("intent_release", {}, toolCallId)), terminate: true };
					},
				}),
			];

			for (const tool of graphSolverTools) pi.registerTool({ ...tool, executionMode: "sequential" });
		},
	};
}
