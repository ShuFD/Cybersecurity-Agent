import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, type Context, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import type { SecHeurConfig } from "../src/config.ts";
import { resolveExecutionMode } from "../src/execution-mode.ts";
import { createSecHeurExtension } from "../src/extension.ts";
import {
	buildProgressJudgeInput,
	formatProgressJudgeReminder,
	ProgressJudge,
	type ProgressJudgeContext,
	parseProgressJudgeResult,
} from "../src/progress-judge.ts";

const usage: AssistantMessage["usage"] = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "judge-provider",
		model: "judge-model",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function config(overrides: Partial<SecHeurConfig["judge"]> = {}): SecHeurConfig {
	return {
		projectRoot: "/project",
		stateDir: "/project/.secheur-agent",
		agentDir: "/project/.secheur-agent/pi",
		legacyRoot: "/legacy",
		pythonExecutable: "python3",
		permissionMode: "default",
		agentFirstOutputTimeoutMs: 120_000,
		agentOutputIdleTimeoutMs: 600_000,
		maxTurns: 80,
		thinkingMode: "adaptive",
		attemptDedupEnabled: false,
		knowledgeBaseEnabled: false,
		mcpServers: {},
		skillPaths: [],
		systemPromptPath: "/legacy/assets/sys_prompt.txt",
		judge: { enabled: true, everyNTurns: 2, maxHistoryMessages: 2, ...overrides },
		executionMode: resolveExecutionMode({ legacyPlanningMode: "off" }),
		planning: {
			mode: "off",
			maxSteps: 12,
			maxTasks: 48,
			leaseTtlMs: 900_000,
			taskTimeoutMs: 600_000,
			maxEvidenceBytes: 16_384,
			executorContextBytes: 16_384,
			evidenceCatalogEnabled: false,
			observerMode: "off",
			taskGranularityPromptEnabled: false,
		},
		registry: { mcpServers: {}, skills: {}, tools: {}, agents: {} },
	};
}

const messages: AgentMessage[] = [
	{ role: "user", content: [{ type: "text", text: "Solve the challenge" }], timestamp: 1 },
	{
		role: "assistant",
		content: [{ type: "text", text: "Tried the same request three times" }],
		api: "openai-completions",
		provider: "main-provider",
		model: "main-model",
		usage,
		stopReason: "stop",
		timestamp: 2,
	},
];

const harnesses: Harness[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

describe("ProgressJudge", () => {
	it("uses the configured Pi model on schedule and parses a model verdict", async () => {
		const mainModel = model("main-provider", "main-model");
		const judgeModel = model("judge-provider", "judge-model");
		const complete = vi.fn(async (_selectedModel: Model<Api>, _context: unknown) =>
			assistant(
				'{"status":"stuck","summary":"Repeated requests made no progress.","suggestion":"Change the input strategy.","confidence":0.9}',
			),
		);
		const ctx = {
			model: mainModel,
			signal: undefined,
			modelRegistry: {
				getAll: () => [mainModel, judgeModel],
				hasConfiguredAuth: () => true,
				complete,
			},
		} as unknown as ProgressJudgeContext;
		const judge = new ProgressJudge(config({ modelProfile: "1" }));

		judge.beginTurn();
		await expect(judge.evaluate(messages, ctx)).resolves.toBeUndefined();
		judge.beginTurn();
		const result = await judge.evaluate(messages, ctx);

		expect(result).toMatchObject({
			turn: 2,
			status: "stuck",
			suggestion: "Change the input strategy.",
			confidence: 0.9,
			model: "judge-provider/judge-model",
			source: "model",
		});
		expect(complete).toHaveBeenCalledTimes(1);
		expect(complete.mock.calls[0][0]).toBe(judgeModel);
		expect(JSON.stringify(complete.mock.calls[0][1])).toContain("Solve the challenge");
		expect(formatProgressJudgeReminder(result!)).toContain("status=stuck");
	});

	it("does not return the previous verdict when context is evaluated twice in one turn", async () => {
		const currentModel = model("main-provider", "main-model");
		const complete = vi.fn(async () =>
			assistant('{"status":"stuck","summary":"No progress.","suggestion":"Change course.","confidence":0.8}'),
		);
		const ctx = {
			model: currentModel,
			signal: undefined,
			modelRegistry: {
				getAll: () => [currentModel],
				hasConfiguredAuth: () => true,
				complete,
			},
		} as unknown as ProgressJudgeContext;
		const judge = new ProgressJudge(config({ everyNTurns: 1 }));
		judge.beginTurn();

		await expect(judge.evaluate(messages, ctx)).resolves.toMatchObject({ status: "stuck" });
		await expect(judge.evaluate(messages, ctx)).resolves.toBeUndefined();
		expect(complete).toHaveBeenCalledTimes(1);
	});

	it("prefers the active authenticated model when a bare model id is ambiguous", async () => {
		const unauthenticated = model("foreign-provider", "MiniMax-M3");
		const currentModel = model("secheur-minimax", "MiniMax-M3");
		const complete = vi.fn(async () => assistant('{"status":"on_track","summary":"Proceed.","confidence":1}'));
		const ctx = {
			model: currentModel,
			signal: undefined,
			modelRegistry: {
				getAll: () => [unauthenticated, currentModel],
				hasConfiguredAuth: (candidate: Model<Api>) => candidate === currentModel,
				complete,
			},
		} as unknown as ProgressJudgeContext;
		const judge = new ProgressJudge(config({ everyNTurns: 1, modelProfile: "MiniMax-M3" }));
		judge.beginTurn();

		await expect(judge.evaluate(messages, ctx)).resolves.toMatchObject({ status: "on_track" });
		expect(complete).toHaveBeenCalledWith(currentModel, expect.anything(), expect.anything());
	});

	it("falls back safely for malformed output and clamps confidence", () => {
		expect(parseProgressJudgeResult("not json", 3, "provider/model")).toMatchObject({
			status: "on_track",
			confidence: 0,
			suggestion: "",
		});
		expect(
			parseProgressJudgeResult(
				'prefix {"status":"course_correct","summary":"Adjust.","suggestion":"Inspect evidence.","confidence":2} suffix',
				4,
				"provider/model",
			),
		).toMatchObject({ status: "course_correct", confidence: 1, suggestion: "Inspect evidence." });
	});

	it("bounds the history supplied to the judge", () => {
		const longMessages = Array.from(
			{ length: 20 },
			(_, index): AgentMessage => ({
				role: "user",
				content: [{ type: "text", text: `${index}:${"x".repeat(3000)}` }],
				timestamp: index,
			}),
		);
		const prompt = buildProgressJudgeInput(longMessages, 3);

		expect(prompt).toContain("## Older history (truncated)");
		expect(prompt).toContain("## Recent messages");
		expect(prompt.length).toBeLessThan(21_000);
	});

	it("degrades without throwing when the judge model call fails", async () => {
		const currentModel = model("main-provider", "main-model");
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const ctx = {
			model: currentModel,
			signal: undefined,
			modelRegistry: {
				getAll: () => [currentModel],
				hasConfiguredAuth: () => true,
				complete: async () => {
					throw new Error("provider unavailable");
				},
			},
		} as unknown as ProgressJudgeContext;
		const judge = new ProgressJudge(config({ everyNTurns: 1 }));
		judge.beginTurn();

		await expect(judge.evaluate(messages, ctx)).resolves.toBeUndefined();
		expect(judge.error).toBe("provider unavailable");
		expect(error).toHaveBeenCalledWith("[judge] evaluation failed: provider unavailable");
	});

	it("injects a scheduled verdict through a real Pi session without recursion", async () => {
		const integrationConfig = config({ everyNTurns: 2, maxHistoryMessages: 8 });
		integrationConfig.legacyRoot = resolve(import.meta.dirname, "../../../legacy");
		integrationConfig.systemPromptPath = resolve(integrationConfig.legacyRoot, "assets/sys_prompt.txt");
		const created = createSecHeurExtension({ config: integrationConfig });
		const harness = await createHarness({ extensionFactories: [created.extension] });
		harnesses.push(harness);
		const providerContexts: Context[] = [];
		harness.setResponses([
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("first turn");
			},
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage(
					'{"status":"course_correct","summary":"The approach is repeating.","suggestion":"Try a different path.","confidence":0.9}',
				);
			},
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("second turn");
			},
		]);

		await harness.session.prompt("first request");
		expect(created.state.getLastJudge()).toBeUndefined();
		expect(harness.faux.state.callCount).toBe(1);

		await harness.session.prompt("second request");

		expect(created.state.getLastJudge()).toMatchObject({ turn: 2, status: "course_correct" });
		expect(harness.faux.state.callCount).toBe(3);
		expect(providerContexts).toHaveLength(3);
		expect(providerContexts[1]?.systemPrompt).toContain("progress judge");
		expect(JSON.stringify(providerContexts[2]?.messages)).toContain("[Progress Judge] status=course_correct");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("skips automatic judging in a child agent extension", async () => {
		const childConfig = config({ everyNTurns: 1 });
		childConfig.legacyRoot = resolve(import.meta.dirname, "../../../legacy");
		childConfig.systemPromptPath = resolve(childConfig.legacyRoot, "assets/sys_prompt.txt");
		const child = createSecHeurExtension({ config: childConfig, subAgentDepth: 1 });
		const harness = await createHarness({ extensionFactories: [child.extension] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("child result")]);

		await harness.session.prompt("delegated work");

		expect(harness.faux.state.callCount).toBe(1);
		expect(child.state.getTurnCount()).toBe(0);
		expect(child.state.getLastJudge()).toBeUndefined();
	});
});
