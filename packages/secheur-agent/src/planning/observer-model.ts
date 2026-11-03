import { Type } from "typebox";
import type { PiPlanningAdapterOptions } from "./pi-adapters.ts";
import { runProposalSession } from "./proposal-session.ts";
import {
	type ObserverSuggestion,
	PlanRunObserver,
	RUN_OBSERVER_POLICY,
	type RunObserverOptions,
} from "./run-observer.ts";

const cited = { topic: Type.String(), text: Type.String(), evidenceIds: Type.Array(Type.String()) };
const observerSchema = Type.Object({
	notes: Type.Array(
		Type.Object({
			...cited,
			kind: Type.Union([
				Type.Literal("memory"),
				Type.Literal("idea"),
				Type.Literal("failure_boundary"),
				Type.Literal("question"),
			]),
		}),
	),
	reminders: Type.Array(Type.Object(cited)),
	corrections: Type.Array(
		Type.Object({ factId: Type.String(), replacementFactId: Type.String(), evidenceIds: Type.Array(Type.String()) }),
	),
});

export function createPlanRunObserver(
	adapter: PiPlanningAdapterOptions,
	options: Omit<RunObserverOptions, "stateDir" | "observe">,
): PlanRunObserver {
	let modelTurns = 0;
	const allowance = Math.max(
		1,
		Math.floor((adapter.config.maxTurns ?? 220) * RUN_OBSERVER_POLICY.maxRunBudgetFraction),
	);
	return new PlanRunObserver({
		...options,
		stateDir: adapter.config.stateDir,
		observe: async (input, signal) => {
			if (modelTurns >= allowance) {
				options.onEvent?.("observer_review_deferred", {
					role: "observer",
					reason: "auxiliary_call_budget",
					modelTurns,
					allowance,
				});
				return {
					runId: input.runId,
					baseVersion: input.version,
					completion: "skipped",
					notes: [],
					reminders: [],
					corrections: [],
				};
			}
			let reviewTurns = 0;
			const startedAt = Date.now();
			try {
				const output = await runProposalSession({
					config: adapter.config,
					cwd: adapter.cwd,
					model: adapter.model,
					modelRuntime: adapter.modelRuntime,
					thinkingLevel: adapter.thinkingLevel,
					role: "observer",
					signal,
					submissionOnly: () => reviewTurns >= 2 || allowance - modelTurns <= 1,
					beforeModelRequest: async (requestSignal) => {
						if (reviewTurns >= RUN_OBSERVER_POLICY.maxReviewModelTurns || modelTurns >= allowance) {
							options.onEvent?.("observer_review_deferred", {
								role: "observer",
								reason: "auxiliary_call_budget",
								modelTurns,
								allowance,
							});
							throw new Error("Observer auxiliary request budget reached; execution continues independently");
						}
						await adapter.beforeDispatch?.(requestSignal);
					},
					onModelTurn: (cost) => {
						reviewTurns++;
						modelTurns++;
						adapter.onModelTurn?.(cost);
					},
					onLifecycleEvent: (type, payload = {}) => {
						const metadata = { ...payload, role: "observer", runId: input.runId };
						options.onEvent?.(type, metadata);
						if (adapter.onLifecycleEvent !== options.onEvent) adapter.onLifecycleEvent?.(type, metadata);
					},
					readEvidence: options.readEvidence,
					outputSchema: observerSchema,
					readonlyContext: {
						run: { runId: input.runId, version: input.version },
						...input.context,
						recent: input.recent,
					},
					task: "Conservatively organize the two executors' saved observations. Prefer no change, then update or merge the same topic. Keep claims unverified and contradictions as questions unless original evidence proves a correction. One failed input only defines its own failure boundary. Never execute, verify an answer, stop an executor, cancel a tool, manufacture a fact, or reject an entire route from one failure. Submit notes, reminders and corrections with exact same-run evidence IDs. Empty arrays are valid. Memory 12 and Ideas 8 are overview targets, not deletion limits.",
					normalizeSubmission(value) {
						return { ...(value as Record<string, unknown>), runId: input.runId, baseVersion: input.version };
					},
					validateSubmission(value) {
						const suggestion = value as ObserverSuggestion;
						const references = [...suggestion.notes, ...suggestion.reminders, ...suggestion.corrections].flatMap(
							(item) => item.evidenceIds,
						);
						if (references.some((id) => !input.evidenceIds.includes(id)))
							throw new Error("Cite only exact evidence IDs from this run");
					},
				});
				const suggestion = JSON.parse(output.finalText) as ObserverSuggestion;
				return {
					...suggestion,
					completion:
						suggestion.notes.length || suggestion.reminders.length || suggestion.corrections.length
							? "submitted"
							: "no_change",
				};
			} finally {
				options.onEvent?.("observer_review_finished", {
					role: "observer",
					reviewTurns,
					modelTurns,
					elapsedMs: Date.now() - startedAt,
				});
			}
		},
	});
}
