import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { OperationalGuard } from "../src/operational-guard.ts";
import { createSecHeurRuntime } from "../src/runtime.ts";

it("rejects a resumed Pi model request after durable verifier exhaustion", async () => {
	const root = mkdtempSync(join(tmpdir(), "terminal-admission-"));
	const faux = fauxProvider({ models: [{ id: "terminal-fixture", reasoning: false }] });
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "fixture" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	faux.setResponses([fauxAssistantMessage("This request must never reach the provider.")]);
	const runtime = await createSecHeurRuntime({
		projectRoot: root,
		legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
		persist: false,
		model: faux.getModel(),
		modelRuntime,
		thinkingLevel: "off",
		env: { PI_OFFLINE: "1", PATH: process.env.PATH },
	});
	try {
		runtime.setKnowledgeBaseEnabled(false);
		runtime.setMemoryReferenceEnabled(false);
		const guard = new OperationalGuard(root, "exhausted-run");
		runtime.state.operationalGuard = guard;
		for (let i = 0; i < 3; i++) {
			guard.observe("bash", {}, `synthetic-proof-${i}`, false);
			guard.reserveVerification(`synthetic-${i}`);
			guard.settleVerification(`synthetic-${i}`, "incorrect");
		}
		await runtime.prompt("Synthetic admission test: do not invoke tools.").catch(() => undefined);
		expect(faux.state.callCount).toBe(0);
	} finally {
		runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
