import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Context,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import type { SecHeurConfig } from "../src/config.ts";
import { generatePlanningProposal } from "../src/planning/proposal-model.ts";
import { cairnProposalSchema } from "../src/planning/proposal-schema.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "planning-proposal-model-"));
	const faux = registerFauxProvider({ tokenSize: { min: 100, max: 100 } });
	cleanup.push(() => {
		faux.unregister();
		rmSync(root, { recursive: true, force: true });
	});
	const model = faux.getModel();
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "local-faux-only" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
	return {
		faux,
		options: {
			config: { agentDir: join(root, "pi") } as SecHeurConfig,
			cwd: root,
			model,
			modelRuntime,
			thinkingLevel: "off" as const,
			task: "Return fixture JSON",
		},
	};
}

describe("CairnPilot stateless Proposal generation", () => {
	it("uses native Pi retry for a transient provider limit and charges each completed request once", async () => {
		const {options}=await fixture();vi.useFakeTimers();
		const complete=vi.spyOn(options.modelRuntime,"completeSimple")
			.mockResolvedValueOnce(fauxAssistantMessage("",{stopReason:"error",errorMessage:"HTTP 429 rate limited"}))
			.mockResolvedValueOnce(fauxAssistantMessage('{"fixture":true}'));
		const onModelTurn=vi.fn();const events:string[]=[];
		try {
			const pending=generatePlanningProposal({...options,onModelTurn,onLifecycleEvent:type=>events.push(type)});
			await vi.runAllTimersAsync();expect(JSON.parse((await pending).finalText)).toEqual({fixture:true});
			expect(complete).toHaveBeenCalledTimes(2);expect(onModelTurn).toHaveBeenCalledTimes(2);
			expect(events.filter(type=>type==="planning_model_request_end")).toHaveLength(2);
			expect(events).toContain("planning_model_retry_scheduled");
		}finally{vi.useRealTimers();}
	});
	it("captures native proposal arguments without executing a tool or adding a model turn", async () => {
		const { faux, options } = await fixture();
		const data = { rationaleSummary: "fixture", proposedIntents: [], supersedeRecommendations: [] };
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("submit_planning_proposal", data), { stopReason: "toolUse" }),
		]);
		const complete = vi.spyOn(options.modelRuntime, "completeSimple");
		expect(
			JSON.parse((await generatePlanningProposal({ ...options, outputSchema: cairnProposalSchema })).finalText),
		).toEqual(data);
		expect(complete).toHaveBeenCalledOnce();
		expect(complete.mock.calls[0][1].tools?.[0].name).toBe("submit_planning_proposal");
	});
	it("rejects multiple native proposals rather than selecting one", async () => {
		const { faux, options } = await fixture();
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("submit_planning_proposal", {}), fauxToolCall("submit_planning_proposal", {})],
				{ stopReason: "toolUse" },
			),
		]);
		await expect(generatePlanningProposal({ ...options, outputSchema: cairnProposalSchema })).rejects.toThrow(
			"exactly one",
		);
	});
	it("uses one user message, no tools, the source system prompt and exact output budget for every call", async () => {
		const { faux, options } = await fixture();
		const contexts: Context[] = [];
		faux.setResponses(
			Array.from({ length: 2 }, () => (context: Context) => {
				contexts.push(context);
				return fauxAssistantMessage([fauxThinking("not proposal data"), fauxText(' {"ok":'), fauxText("true} ")]);
			}),
		);
		const complete = vi.spyOn(options.modelRuntime, "completeSimple");
		for (let i = 0; i < 2; i++) {
			expect((await generatePlanningProposal({ ...options, maxOutputTokens: 3_000 })).finalText).toBe('{"ok":true}');
		}
		expect(complete).toHaveBeenCalledTimes(2);
		for (const call of complete.mock.calls) {
			expect(call[0]).toBe(options.model); // no cloned maxTokens metadata
			expect(call[2]).toMatchObject({ maxTokens: 3_000, reasoning: undefined });
		}
		for (const context of contexts) {
			expect(context.systemPrompt).toBe(
				"Return only the requested JSON object. Do not emit hidden reasoning or tool calls.",
			);
			expect(context.tools).toBeUndefined();
			expect(context.messages).toHaveLength(1);
			expect(context.messages[0]).toMatchObject({ role: "user", content: options.task });
		}
	});

	it.each(["error", "aborted"] as const)("propagates provider %s without a recovery loop", async (stopReason) => {
		const { faux, options } = await fixture();
		faux.setResponses([fauxAssistantMessage("ignored", { stopReason, errorMessage: "provider failed" })]);
		const complete = vi.spyOn(options.modelRuntime, "completeSimple");
		await expect(generatePlanningProposal(options)).rejects.toThrow("provider failed");
		expect(complete).toHaveBeenCalledOnce();
	});

	it("preserves parent cancellation before generation without making a request", async () => {
		const { options } = await fixture();
		const parent = new AbortController();
		const reason = new Error("parent cancelled");
		parent.abort(reason);
		const complete = vi.spyOn(options.modelRuntime, "completeSimple");
		await expect(generatePlanningProposal({ ...options, signal: parent.signal })).rejects.toBe(reason);
		expect(complete).not.toHaveBeenCalled();
	});

	it("returns length-stopped text to the existing parser instead of guessing or rejecting it", async () => {
		const { faux, options } = await fixture();
		faux.setResponses([fauxAssistantMessage('{"ok":true}', { stopReason: "length" })]);
		const result = await generatePlanningProposal(options);
		expect(JSON.parse(result.finalText)).toEqual({ ok: true });
		expect(result.messages[0].stopReason).toBe("length");
	});

	it("never executes a tool call or starts a follow-up generation", async () => {
		const { faux, options } = await fixture();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "not executed" }), { stopReason: "toolUse" }),
		]);
		const complete = vi.spyOn(options.modelRuntime, "completeSimple");
		expect((await generatePlanningProposal(options)).finalText).toBe("");
		expect(complete).toHaveBeenCalledOnce();
	});
});
