import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	EVIDENCE_CARD_MAX_REFS,
	EVIDENCE_MAX_PAGE_SIZE,
	type EvidenceCard,
	type EvidenceCardInput,
} from "./evidence-cards.ts";

export const evidenceCardSchema = Type.Object(
	{
		summary: Type.String({
			minLength: 1,
			description: "Aim for 30–50 characters; preserve meaningful findings and exact values.",
		}),
		keyValues: Type.Record(Type.String(), Type.Unknown()),
		scope: Type.String({ minLength: 1, maxLength: 1000 }),
		limitations: Type.String({ maxLength: 1000 }),
		evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
			minItems: 1,
			maxItems: EVIDENCE_CARD_MAX_REFS,
		}),
		basis: Type.Optional(Type.Union([Type.Literal("observed"), Type.Literal("inferred")])),
	},
	{ additionalProperties: false },
);

export interface EvidenceCardAccess {
	publish(input: EvidenceCardInput): EvidenceCard;
	list(after?: number, limit?: number): { items: EvidenceCard[]; nextCursor: number; hasMore: boolean };
}
export function evidenceCardExtension(access: EvidenceCardAccess): InlineExtension {
	return {
		name: "planning-evidence-cards",
		factory(pi) {
			pi.registerTool({
				name: "planning_publish_evidence_card",
				label: "Publish evidence card",
				description:
					"Publish a supported semantic finding at a useful checkpoint. Cite host-saved tool evidence; distinguish observed/inferred. This does not finish a task or verify a hypothesis or the goal.",
				parameters: evidenceCardSchema,
				execute: async (_id, input) => {
					const card = access.publish(input);
					return { content: [{ type: "text", text: JSON.stringify(card) }], details: card };
				},
			});
			pi.registerTool({
				name: "planning_list_evidence_cards",
				label: "Read evidence cards",
				description:
					"Read the shared semantic evidence board across tasks. Default 20 cards; follow nextCursor when hasMore. Cards are executor reports, not verified truth.",
				parameters: Type.Object({
					cursor: Type.Optional(Type.Integer({ minimum: 0 })),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: EVIDENCE_MAX_PAGE_SIZE })),
				}),
				execute: async (_id, input) => {
					const page = access.list(input.cursor, input.limit);
					return { content: [{ type: "text", text: JSON.stringify(page) }], details: page };
				},
			});
		},
	};
}
