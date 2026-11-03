import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { type DesktopJson, writeDesktopConfig } from "../src/desktop-config.ts";
import { createSecHeurRuntime } from "../src/runtime.ts";

const temporaryRoots: string[] = [];
const legacyRoot = resolve(import.meta.dirname, "../../../legacy");

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "secheur-runtime-budget-test-"));
	temporaryRoots.push(root);
	return root;
}

async function createFauxRuntime(root: string, desktopConfig: DesktopJson, reasoning = false) {
	writeDesktopConfig(root, { ...desktopConfig, judge: { enabled: false } });
	const faux = fauxProvider({ models: [{ id: "faux-1", reasoning }] });
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	const runtime = await createSecHeurRuntime({
		projectRoot: root,
		legacyRoot,
		persist: false,
		model: faux.getModel(),
		modelRuntime,
		env: {
			PATH: process.env.PATH,
			PI_OFFLINE: "1",
			SECHEUR_PYTHON: resolve(import.meta.dirname, "../../../.secheur-agent/python/bin/python"),
		},
	});
	runtime.setMemoryReferenceEnabled(false);
	return { faux, runtime };
}

function fauxJudgeResponse() {
	return fauxAssistantMessage(
		JSON.stringify({
			status: "on_track",
			summary: "Budget test is on track.",
			suggestion: "",
			confidence: 1,
		}),
	);
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime configuration", () => {
	it("normalizes desktop budget and thinking settings", () => {
		const root = temporaryRoot();
		writeDesktopConfig(root, {
			maxTurns: 500,
			maxCost: "2.5",
			thinkingMode: "enabled",
			thinkingBudget: "4096",
		});

		const config = loadSecHeurConfig({ projectRoot: root, legacyRoot, env: {} });

		expect(config).toMatchObject({
			maxTurns: 500,
			maxCost: 2.5,
			thinkingMode: "enabled",
			thinkingBudget: 4_096,
		});

		const unlimitedRoot = temporaryRoot();
		writeDesktopConfig(unlimitedRoot, { maxTurns: 0 });
		const unlimited = loadSecHeurConfig({ projectRoot: unlimitedRoot, legacyRoot, env: {} });
		expect(unlimited.maxTurns).toBeUndefined();

		const defaultsRoot = temporaryRoot();
		writeDesktopConfig(defaultsRoot, {
			maxTurns: -1,
			maxCost: "",
			thinkingMode: "invalid",
			thinkingBudget: -1,
		});
		const defaults = loadSecHeurConfig({ projectRoot: defaultsRoot, legacyRoot, env: {} });
		expect(defaults.maxTurns).toBe(80);
		expect(defaults.maxCost).toBeUndefined();
		expect(defaults.thinkingMode).toBe("adaptive");
		expect(defaults.thinkingBudget).toBeUndefined();
	});
});

describe("runtime budgets", () => {
	it("stops a tool loop at maxTurns and resets the counter for the next prompt", async () => {
		const root = temporaryRoot();
		const evidencePath = join(root, "evidence.txt");
		writeFileSync(evidencePath, "evidence\n");
		const { faux, runtime } = await createFauxRuntime(root, { maxTurns: 2 });
		let agentCallCount = 0;
		let judgeCallCount = 0;
		const response = (_context: Context, options: SimpleStreamOptions | undefined) => {
			if (options?.maxTokens === 700) {
				judgeCallCount += 1;
				return fauxJudgeResponse();
			}
			agentCallCount += 1;
			return agentCallCount <= 2
				? fauxAssistantMessage(fauxToolCall("read", { path: evidencePath }), { stopReason: "toolUse" })
				: fauxAssistantMessage("done");
		};
		faux.setResponses(Array.from({ length: 10 }, () => response));

		try {
			await runtime.prompt("Read until the task is complete.");

			expect(agentCallCount).toBe(2);
			expect(faux.state.callCount).toBe(agentCallCount + judgeCallCount);
			expect(runtime.getBudgetStatus()).toMatchObject({
				maxTurns: 2,
				turnsUsed: 2,
				stopped: true,
				reason: "maxTurns",
			});
			expect(
				runtime.session.messages.some(
					(message) => message.role === "custom" && message.customType === "secheur-budget",
				),
			).toBe(true);

			await runtime.prompt("Finish now.");
			expect(agentCallCount).toBe(3);
			expect(faux.state.callCount).toBe(agentCallCount + judgeCallCount);
			expect(runtime.getBudgetStatus()).toMatchObject({ turnsUsed: 1, stopped: false });
		} finally {
			runtime.dispose();
		}
	}, 20_000);

	it("allows an unlimited tool loop when maxTurns is zero", async () => {
		const root = temporaryRoot();
		const evidencePath = join(root, "evidence.txt");
		writeFileSync(evidencePath, "evidence\n");
		const { faux, runtime } = await createFauxRuntime(root, { maxTurns: 0 });
		let agentCallCount = 0;
		faux.setResponses([
			...Array.from({ length: 3 }, () => () => {
				agentCallCount += 1;
				return fauxAssistantMessage(fauxToolCall("read", { path: evidencePath }), { stopReason: "toolUse" });
			}),
			() => {
				agentCallCount += 1;
				return fauxAssistantMessage("done");
			},
		]);

		try {
			await runtime.prompt("Read until the task is complete.");

			expect(agentCallCount).toBe(4);
			expect(runtime.getBudgetStatus()).toMatchObject({
				maxTurns: null,
				turnsUsed: 4,
				stopped: false,
			});
		} finally {
			runtime.dispose();
		}
	}, 20_000);

	it("stops when the persisted session cost reaches maxCost", async () => {
		const root = temporaryRoot();
		const evidencePath = join(root, "evidence.txt");
		writeFileSync(evidencePath, "evidence\n");
		const { faux, runtime } = await createFauxRuntime(root, { maxTurns: 10, maxCost: 0.5 });
		const model = faux.getModel();
		runtime.session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "prior response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1,
				cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		let agentCallCount = 0;
		let judgeCallCount = 0;
		const response = (_context: Context, options: SimpleStreamOptions | undefined) => {
			if (options?.maxTokens === 700) {
				judgeCallCount += 1;
				return fauxJudgeResponse();
			}
			agentCallCount += 1;
			return agentCallCount === 1
				? fauxAssistantMessage(fauxToolCall("read", { path: evidencePath }), { stopReason: "toolUse" })
				: fauxAssistantMessage("must not run");
		};
		faux.setResponses(Array.from({ length: 10 }, () => response));

		try {
			await runtime.prompt("Continue the task.");

			expect(agentCallCount).toBe(1);
			expect(faux.state.callCount).toBe(agentCallCount + judgeCallCount);
			expect(runtime.getBudgetStatus()).toMatchObject({
				maxCost: 0.5,
				turnsUsed: 1,
				cost: 1,
				stopped: true,
				reason: "maxCost",
			});
		} finally {
			runtime.dispose();
		}
	}, 20_000);

	it("forwards an enabled thinking budget to the provider", async () => {
		const root = temporaryRoot();
		const { faux, runtime } = await createFauxRuntime(root, { thinkingMode: "enabled", thinkingBudget: 4_096 }, true);
		let capturedOptions: SimpleStreamOptions | undefined;
		faux.setResponses([
			(_context, options) => {
				capturedOptions = options;
				return fauxAssistantMessage("done");
			},
		]);

		try {
			await runtime.prompt("Answer once.");

			expect(runtime.session.thinkingLevel).toBe("medium");
			expect(capturedOptions).toMatchObject({
				reasoning: "medium",
				thinkingBudgets: { minimal: 4_096, low: 4_096, medium: 4_096, high: 4_096 },
			});
		} finally {
			runtime.dispose();
		}
	}, 20_000);

	it("keeps thinking disabled when the TUI changes the level", async () => {
		const root = temporaryRoot();
		const { runtime } = await createFauxRuntime(root, { thinkingMode: "disabled" }, true);

		try {
			expect(runtime.session.thinkingLevel).toBe("off");
			runtime.session.setThinkingLevel("high");
			expect(runtime.session.thinkingLevel).toBe("off");
		} finally {
			runtime.dispose();
		}
	}, 20_000);
});
