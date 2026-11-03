import { Type } from "typebox";

const strings = () => Type.Array(Type.String());
const coverage = Type.Optional(
	Type.Object({
		remaining: Type.Array(
			Type.Object({
				question: Type.String({ minLength: 1, maxLength: 500 }),
				ownerId: Type.Optional(Type.String()),
				dependsOn: Type.Optional(strings()),
				evidenceIds: Type.Optional(strings()),
			}),
			{ minItems: 1, maxItems: 16 },
		),
		recheckOn: Type.String({ minLength: 1, maxLength: 500 }),
	}),
);
export const planningProposalSchema = Type.Object({
	schemaVersion: Type.Optional(Type.Integer()),
	expectedRevision: Type.Optional(Type.Integer()),
	decision: Type.Union([Type.Literal("create_tasks"), Type.Literal("finish_run"), Type.Literal("blocked")]),
	rationale: Type.String(),
	coverage,
	tasks: Type.Array(
		Type.Object({
			key: Type.Optional(Type.String()),
			increment: Type.Optional(Type.String()),
			incrementEvidenceIds: Type.Optional(strings()),
			objective: Type.String(),
			doneWhen: Type.String(),
			priority: Type.Optional(Type.Integer()),
			dependsOn: Type.Optional(strings()),
			inputEvidenceRefs: Type.Optional(strings()),
			parent: Type.Optional(Type.String()),
		}),
	),
	answerEvidenceRefs: Type.Optional(strings()),
});

export { cairnProposalSchema } from "./cairn/submission-contract.ts";
