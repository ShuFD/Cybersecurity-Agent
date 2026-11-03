/** Adapted from sxd-git1/cairnpilot b015733fa117aa35f2406b8b31fd1bbf84d3ec6e.
 * Apache-2.0; see vendor/cairnpilot/LICENSE and NOTICE.md. */
import type { GraphEvent } from "./types.ts";

export const SHADOW_MIGRATION_ACTOR = "shadow-migration";

export type ShadowGraphEventType = "shadow_fact_imported" | "shadow_hint_imported" | "shadow_intent_imported";

export function createShadowGraphEvent(input: {
	challengeId: string;
	snapshotFingerprint: string;
	type: ShadowGraphEventType;
	entityId: string;
	sourceIds: string[];
	payload?: Record<string, unknown>;
	createdAt: string;
}): Omit<GraphEvent, "sequence"> {
	return {
		challengeId: input.challengeId,
		type: input.type,
		entityId: input.entityId,
		actorId: SHADOW_MIGRATION_ACTOR,
		idempotencyKey: `shadow:${input.type}:${input.challengeId}:${input.entityId}:${input.snapshotFingerprint}`,
		payload: { sourceIds: [...input.sourceIds].sort(), ...input.payload },
		createdAt: input.createdAt,
	};
}
