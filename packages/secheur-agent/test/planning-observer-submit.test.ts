import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { createPlanRunObserver } from "../src/planning/observer-model.ts";

it("uses two observation calls then offers only submission; later quota skips are not successful observations", async () => {
	const root = mkdtempSync(join(tmpdir(), "observer-submit-"));
	const faux = fauxProvider({ models: [{ id: "fixture", reasoning: false }] });
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
	config.maxTurns = 30;
	const event = vi.fn();
	const outer = new AbortController();
	let finalTools: string[] = [];
	let observerPrompt = "";
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("planning_query_context", { section: "run" }, { id: "q1" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(fauxToolCall("planning_query_context", { section: "evidence" }, { id: "q2" }), {
			stopReason: "toolUse",
		}),
		(context) => {
			observerPrompt = context.systemPrompt ?? "";
			finalTools = context.tools?.map((tool) => tool.name) ?? [];
			return fauxAssistantMessage(
				fauxToolCall("submit_planning_proposal", { notes: [], reminders: [], corrections: [] }, { id: "submit" }),
				{ stopReason: "toolUse" },
			);
		},
	]);
	const observer = createPlanRunObserver(
		{ config, cwd: root, model: faux.getModel(), modelRuntime: runtime, thinkingLevel: "off" },
		{
			runId: "run",
			mode: "report",
			signal: outer.signal,
			onEvent: event,
			snapshot: () => ({ runId: "run", version: 1, evidenceIds: [], context: { evidence: [] } }),
		},
	);
	try {
		for (let turn = 0; turn < 6; turn++) observer.recordTurn(turn % 2 ? "a" : "b", { turn });
		await observer.waitForIdle();
		expect(faux.state.callCount).toBe(3);
		expect(observerPrompt).toContain("read-only Observer");
		expect(finalTools).toEqual(["submit_planning_proposal"]);
		expect(
			event.mock.calls.filter(([kind]) => ["observer_shadow_recorded", "observer_request_failed"].includes(kind)),
		).toContainEqual(["observer_shadow_recorded", expect.objectContaining({ status: "no_change" })]);
		for (let turn = 0; turn < 6; turn++) observer.recordTurn("a", { turn });
		await observer.waitForIdle();
		expect(faux.state.callCount).toBe(3);
		expect(event.mock.calls.some(([kind]) => kind === "observer_review_skipped")).toBe(true);
		expect(outer.signal.aborted).toBe(false);
	} finally {
		observer.close();
		rmSync(root, { recursive: true, force: true });
	}
});
