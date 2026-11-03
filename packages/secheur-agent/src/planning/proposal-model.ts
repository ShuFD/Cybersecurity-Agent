/** Adapted from sxd-git1/cairnpilot b015733fa117aa35f2406b8b31fd1bbf84d3ec6e,
 * packages/core/src/graph/reason-model.ts. Apache-2.0; see vendor/cairnpilot. */
import { join } from "node:path";
import { type AssistantMessage, retryAssistantCall } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { RunPiCodingTaskOptions } from "../subagent.ts";
import { awaitModelAvailability, deferModelAvailability, providerPlanningFailure } from "./model-availability.ts";
import { ProposalOutputError } from "./proposal-json.ts";
import { type ProposalSessionOptions, runProposalSession } from "./proposal-session.ts";

type ProposalModelOptions = Pick<
	RunPiCodingTaskOptions,
	| "config"
	| "cwd"
	| "model"
	| "modelRuntime"
	| "thinkingLevel"
	| "task"
	| "signal"
	| "onLifecycleEvent"
	| "onModelTurn"
> & {
	maxOutputTokens?: number;
	outputSchema?: TSchema;
	beforeDispatch?: (signal?: AbortSignal) => Promise<void>;
	nativeSession?: Pick<
		ProposalSessionOptions,
		| "readonlyContext"
		| "normalizeSubmission"
		| "validateSubmission"
		| "readEvidence"
		| "queryContext"
		| "queryPolicy"
		| "compactBoardContext"
	>;
};

/** Native read-only Pi session for production planners; legacy completion for compatible callers. */
export async function generatePlanningProposal(options: ProposalModelOptions): Promise<{
	finalText: string;
	messages: AssistantMessage[];
}> {
	options.signal?.throwIfAborted();
	await options.beforeDispatch?.(options.signal);
	if (options.nativeSession && options.outputSchema)
		return runProposalSession({
			...options,
			...options.nativeSession,
			outputSchema: options.outputSchema,
			beforeModelRequest: options.beforeDispatch,
		});
	const runtime =
		options.modelRuntime ??
		(await ModelRuntime.create({
			authPath: join(options.config.agentDir, "auth.json"),
			modelsPath: join(options.config.agentDir, "models.json"),
			signal: options.signal,
		}));
	const settings =
		options.model && options.thinkingLevel !== undefined
			? undefined
			: SettingsManager.create(options.cwd, options.config.agentDir);
	const provider = settings?.getDefaultProvider();
	const id = settings?.getDefaultModel();
	const saved = provider && id ? runtime.getModel(provider, id) : undefined;
	const model =
		options.model ??
		(saved && runtime.hasConfiguredAuth(saved.provider) ? saved : undefined) ??
		runtime.getAvailableSnapshot()[0];
	if (!model) throw new Error("Planning proposal model is not configured");
	const thinking = options.thinkingLevel ?? settings?.getDefaultThinkingLevel();
	const emit = (type: string, payload: Record<string, unknown> = {}) => {
		try {
			options.onLifecycleEvent?.(type, payload);
		} catch {
			/* Diagnostics cannot change generation. */
		}
	};
	emit("proposal_generation_start");
	try {
		const retrySettings = SettingsManager.create(options.cwd, options.config.agentDir).getRetrySettings();
		const providerKey = `${model.provider}:${model.id}`;
		const result = await retryAssistantCall(
			async () => {
				await options.beforeDispatch?.(options.signal);
				const availabilityStart = Date.now();
				await awaitModelAvailability(runtime, providerKey, options.signal);
				const requestStart = Date.now();
				const response = await runtime.completeSimple(
					model,
					{
						systemPrompt: options.outputSchema
							? "Submit exactly one requested proposal using submit_planning_proposal. This is a data submission only, not an executable tool. If tool calling is unavailable, return only the JSON object."
							: "Return only the requested JSON object. Do not emit hidden reasoning or tool calls.",
						...(options.outputSchema
							? {
									tools: [
										{
											name: "submit_planning_proposal",
											description: "Submit the planning proposal as structured data",
											parameters: options.outputSchema,
										},
									],
								}
							: {}),
						messages: [{ role: "user", content: options.task, timestamp: Date.now() }],
					},
					{
						signal: options.signal,
						...(options.maxOutputTokens !== undefined ? { maxTokens: options.maxOutputTokens } : {}),
						reasoning: thinking === "off" ? undefined : thinking,
					},
				);
				options.onModelTurn?.(response.usage.cost.total);
				emit("planning_model_request_end", {
					isError: response.stopReason === "error",
					stopReason: response.stopReason,
					availabilityWaitMs: Math.max(0, requestStart - availabilityStart),
					requestElapsedMs: Math.max(0, Date.now() - requestStart),
					inputTokens: response.usage.input,
					outputTokens: response.usage.output,
				});
				return response;
			},
			retrySettings,
			options.signal,
			{
				onRetryScheduled: (_attempt, _maxAttempts, delayMs, message) => {
					const failure = providerPlanningFailure(new Error(message));
					const delay = Math.max(delayMs, failure?.retryAfterMs ?? 0);
					deferModelAvailability(runtime, providerKey, delay);
					emit("planning_model_retry_scheduled", {
						attempt: _attempt,
						delayMs: delay,
						failureCode: failure?.code ?? "model_request_retry",
					});
				},
			},
		);
		options.signal?.throwIfAborted();
		if (result.stopReason === "error" || result.stopReason === "aborted") {
			const error = new Error(result.errorMessage?.trim() || `Reason model stopped with ${result.stopReason}`);
			throw providerPlanningFailure(error) ?? error;
		}
		const calls = result.content.filter((item) => item.type === "toolCall");
		if (
			options.outputSchema &&
			calls.length > 0 &&
			(calls.length !== 1 || calls[0].name !== "submit_planning_proposal")
		) {
			throw new ProposalOutputError("Expected exactly one submit_planning_proposal data submission", {
				text: JSON.stringify(calls),
				model: result.model,
				provider: result.provider,
			});
		}
		const text =
			options.outputSchema && calls.length === 1
				? JSON.stringify(calls[0].arguments)
				: result.content
						.filter((item): item is { type: "text"; text: string } => item.type === "text")
						.map((item) => item.text)
						.join("")
						.trim();
		emit("proposal_generation_end", { stopReason: result.stopReason, outputChars: text.length, isError: false });
		return { finalText: text, messages: [result] };
	} catch (error) {
		emit("proposal_generation_end", { isError: true });
		if (options.signal?.aborted) throw options.signal.reason ?? error;
		throw providerPlanningFailure(error) ?? error;
	}
}
