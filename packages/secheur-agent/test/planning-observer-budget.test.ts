import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { createPlanRunObserver } from "../src/planning/observer-model.ts";
import {
	observerTurnOverview,
	planningContextOverview,
	planningRecordOverview,
} from "../src/planning/readonly-overview.ts";

it("bounds a runaway observer's provider calls without aborting either executor or changing the shared outer limit", async () => {
	const root = mkdtempSync(join(tmpdir(), "observer-budget-"));
	const faux = fauxProvider({ models: [{ id: "observer-fixture", reasoning: false }] });
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "fixture" }));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	const config = loadSecHeurConfig({
		projectRoot: root,
		stateDir: join(root, "state"),
		legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
		env: { PI_OFFLINE: "1" },
	});
	config.skillPaths = [];
	config.systemPromptPath = "";
	config.maxTurns = 20;
	const signal = new AbortController();
	const sharedTurn = vi.fn();
	const event = vi.fn();
	faux.setResponses(
		Array.from({ length: 10 }, (_, id) =>
			fauxAssistantMessage(fauxToolCall("planning_query_context", { section: "run" }, { id: `query-${id}` }), {
				stopReason: "toolUse",
			}),
		),
	);
	const observer = createPlanRunObserver(
		{
			config,
			cwd: root,
			model: faux.getModel(),
			modelRuntime: runtime,
			thinkingLevel: "off",
			onModelTurn: sharedTurn,
		},
		{
			runId: "fixture",
			mode: "report",
			signal: signal.signal,
			onEvent: event,
			snapshot: () => ({
				runId: "fixture",
				version: 1,
				evidenceIds: ["proof"],
				context: { evidence: [{ evidenceId: "proof", content: "synthetic" }] },
			}),
		},
	);
	try {
		for (let turn = 0; turn < 6; turn++) observer.recordTurn(turn % 2 ? "a" : "b", { turn });
		await observer.waitForIdle();
		expect(faux.state.callCount).toBe(2);
		expect(sharedTurn).toHaveBeenCalledTimes(2);
		for (let turn = 6; turn < 18; turn++) {
			observer.recordTurn(turn % 2 ? "a" : "b", { turn });
			await observer.waitForIdle();
		}
		expect(faux.state.callCount).toBe(2);
		expect(signal.signal.aborted).toBe(false);
		expect(config.maxTurns).toBe(20);
		expect(event.mock.calls.some(([type]) => type === "observer_review_deferred")).toBe(true);
	} finally {
		observer.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("uses bounded previews instead of passing whole assistant messages and tool arguments to the observer", () => {
	const source = {
		taskId: "task",
		message: {
			content: [
				{ type: "text", text: "x".repeat(10000) },
				{ type: "toolCall", name: "synthetic", arguments: { value: "y".repeat(10000) } },
			],
		},
	};
	const overview = observerTurnOverview(source);
	expect(JSON.stringify(overview).length).toBeLessThan(1000);
	expect(source.message.content[0].text).toHaveLength(10000);
	expect(planningRecordOverview([{ evidenceId: "proof", content: "z".repeat(10000) }])).toEqual([
		{ evidenceId: "proof", content: "z".repeat(240) + "…" },
	]);
});

it("preserves both workers' compact activity in valid JSON without filling the prompt with raw evidence", () => {
	const turn = observerTurnOverview({
		message: {
			content: [
				{ type: "text", text: "synthetic summary " + "x".repeat(10000) },
				{ type: "toolCall", name: "synthetic", arguments: { value: "y".repeat(10000) } },
			],
		},
	});
	const context = {
		run: { runId: "fixture" },
		recent: { a: Array(10).fill(turn), b: Array(10).fill(turn) },
		evidence: Array.from({ length: 100 }, (_, id) => ({ evidenceId: `proof-${id}`, content: "z".repeat(10000) })),
	};
	const overview = planningContextOverview(context);
	const text = JSON.stringify(overview);
	expect(text.length).toBeLessThan(17000);
	expect(text).toContain('"a"');
	expect(text).toContain('"b"');
	expect(text).toContain("synthetic summary");
	expect(text).not.toContain("z".repeat(1000));
	expect(JSON.parse(text)).toEqual(overview);
	expect(context.evidence[0].content).toHaveLength(10000);
});
