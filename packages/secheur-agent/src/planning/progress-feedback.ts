import { operationalDigest } from "../operational-guard.ts";
import type { PlanningCheckpointInput } from "./contracts.ts";

// OpenHands' event window and action-error/action-observation thresholds.
export const PROGRESS_EVENT_WINDOW = 20;
export const PROGRESS_ERROR_THRESHOLD = 3;
export const PROGRESS_REPEAT_THRESHOLD = 4;

/** Per-executor evidence feedback; never cancels work or decides goal completion. */
export class PlanningProgressFeedback {
	private readonly recent: { call: string; observation: string }[] = [];
	private readonly notices = new Map<string, string>();
	private readonly completedCalls = new Set<string>();
	private latestFeedback = "";
	private latestCall = "";

	observe(input: {
		toolCallId: string;
		toolName: string;
		toolInput?: unknown;
		result: unknown;
		isError: boolean;
		backgroundCompletion?: boolean;
		evidenceId: string;
		verifierStatus?: string;
	}): PlanningCheckpointInput | undefined {
		const completion = `${input.toolCallId}:${input.backgroundCompletion ? "background" : "foreground"}`;
		if (this.completedCalls.has(completion)) return;
		this.completedCalls.add(completion);
		if (this.completedCalls.size > 256) this.completedCalls.delete(this.completedCalls.values().next().value!);
		const call = operationalDigest([input.toolName, input.toolInput]);
		const observation = operationalDigest([input.result, input.isError]);
		const previous = [...this.recent].reverse().find((event) => event.call === call);
		if (previous && previous.observation !== observation) {
			this.notices.delete(call);
			if (this.latestCall === call) this.latestFeedback = "";
		}
		this.recent.push({ call, observation });
		if (this.recent.length > PROGRESS_EVENT_WINDOW) this.recent.shift();
		for (const key of this.notices.keys())
			if (!this.recent.some((event) => event.call === key)) this.notices.delete(key);
		let repeats = 0;
		for (const event of [...this.recent].reverse()) {
			if (event.call !== call) continue;
			if (event.observation !== observation) break;
			repeats++;
		}
		const loop = repeats >= (input.isError ? PROGRESS_ERROR_THRESHOLD : PROGRESS_REPEAT_THRESHOLD);
		const freshLoop = loop && this.notices.get(call) !== observation;
		if (freshLoop) this.notices.set(call, observation);
		const rejected = ["incorrect", "duplicate", "fresh_evidence_required"].includes(input.verifierStatus ?? "");
		const background = input.backgroundCompletion === true;
		const reported = input.toolName === "update_working_checkpoint" && !input.isError;
		if (!freshLoop && !rejected && !background && !reported) return;
		const summary = freshLoop
			? `${input.toolName} repeated the same ${input.isError ? "error" : "observation"} ${repeats} times. Inspect saved evidence and change the request or approach; do not keep polling unchanged state.`
			: rejected
				? `Native verification returned ${input.verifierStatus}. Read the shared verification history and candidate evidence before correcting it; identical candidates remain blocked. A blocked request is not an incorrect verdict.`
				: `Host observed ${background ? "background tool completion" : "an executor progress report"} for ${input.toolName}. The overall goal remains unverified.`;
		this.latestFeedback = summary;
		this.latestCall = call;
		const investigate = freshLoop || rejected || (background && input.isError);
		return {
			summary,
			evidenceRefs: [input.evidenceId],
			completedItems: background && !input.isError ? ["Background tool completed; saved output is available"] : [],
			remainingItems: ["Continue the current owned task and verify the overall goal using native evidence"],
			rejectedDirections: investigate
				? [
						{
							direction: `Repeat unchanged ${input.toolName} call`,
							reason: summary,
							evidenceRefs: [input.evidenceId],
						},
					]
				: [],
			artifacts: [],
			suggestedNextSteps: investigate
				? [
						{
							objective:
								"Inspect referenced failure evidence and identify a concrete correction or independent alternative, preserving the current executor's work",
							doneWhen:
								"A grounded correction or independent next step is recorded; this does not prove goal completion",
							inputEvidenceRefs: [input.evidenceId],
							dependsOnCurrent: false,
						},
					]
				: [],
		};
	}

	context(): string {
		return this.latestFeedback
			? `[Host progress feedback] ${this.latestFeedback} Continue useful work; this is not a stop instruction.`
			: "";
	}
}
