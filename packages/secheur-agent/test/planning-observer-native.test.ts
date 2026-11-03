import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { createPlanRunObserver } from "../src/planning/observer-model.ts";

it.each([false, true])("uses one readonly Pi Observer for both workers, budget blocked=%s", async (blocked) => {
	const root = mkdtempSync(join(tmpdir(), "observer-native-"));
	const faux = fauxProvider({ models: [{ id: "same-model", reasoning: false }] });
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "fixture" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	const config = loadSecHeurConfig({
		projectRoot: root,
		stateDir: join(root, "state"),
		legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
		env: { PI_OFFLINE: "1" },
	});
	config.skillPaths = [];
	config.systemPromptPath = "";
	const account = vi.fn();
	const lifecycle = vi.fn();
	faux.setResponses([
		(context) => {
			expect(context.tools?.map((tool) => tool.name).sort()).toEqual([
				"planning_query_context",
				"planning_read_evidence",
				"planning_read_evidence_batch",
				"submit_planning_proposal",
			]);
			return fauxAssistantMessage(
				fauxToolCall("submit_planning_proposal", {
					notes: [
						{
							topic: "one-input",
							kind: "failure_boundary",
							text: "Only one synthetic input failed; the route remains unverified.",
							evidenceIds: ["original"],
						},
					],
					reminders: [],
					corrections: [],
				}),
				{ stopReason: "toolUse" },
			);
		},
	]);
	const observer = createPlanRunObserver(
		{
			config,
			cwd: root,
			model: faux.getModel(),
			modelRuntime,
			thinkingLevel: "off",
			onModelTurn: account,
			onLifecycleEvent: lifecycle,
			beforeDispatch: async () => {
				if (blocked) throw new Error("verifier_quota_exhausted");
			},
		},
		{
			runId: "current",
			mode: "report",
			snapshot: () => ({
				runId: "current",
				version: 1,
				evidenceIds: ["original"],
				context: { evidence: [{ evidenceId: "original" }] },
			}),
			readEvidence: async () => ({ content: "original synthetic input failure" }),
		},
	);
	try {
		for (let turn = 0; turn < 6; turn++) observer.recordTurn(turn % 2 ? "second" : "first", { turn });
		await observer.waitForIdle();
		expect(faux.state.callCount).toBe(blocked ? 0 : 1);
		expect(account).toHaveBeenCalledTimes(blocked ? 0 : 1);
		expect(observer.overview()).toEqual([]);
		expect(observer.takeReminders("first")).toEqual([]);
		if (!blocked) {
			const directory = join(config.stateDir, "planning", "run-observer");
			const saved = readFileSync(join(directory, readdirSync(directory)[0]!, "suggestions.jsonl"), "utf8");
			expect(saved).toContain("route remains unverified");
			expect(
				lifecycle.mock.calls.some(
					([type, value]) =>
						type === "coding_task_start" && value.role === "observer" && value.model === "same-model",
				),
			).toBe(true);
		}
	} finally {
		observer.close();
		rmSync(root, { recursive: true, force: true });
	}
});
