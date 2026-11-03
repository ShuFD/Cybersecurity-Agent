import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { CairnHostEvidence } from "../src/planning/cairn/host-evidence.ts";
import { GraphService } from "../src/planning/cairn/service.ts";
import { CairnSolverAdapter } from "../src/planning/cairn/solver.ts";
import { GraphStore } from "../src/planning/cairn/store.ts";
import * as subagent from "../src/subagent.ts";

interface TestTool {
	name: string;
	execute(id: string, args: unknown): Promise<AgentToolResult<unknown>>;
}

it("Cairn corrects missing evidence and record IDs through its existing same-run tools without ending work", async () => {
	const root = mkdtempSync(join(tmpdir(), "cairn-evidence-interface-"));
	const store = new GraphStore(":memory:");
	store.initialize();
	const service = new GraphService(store);
	const evidence = new CairnHostEvidence(join(root, "host.sqlite"));
	const config = loadSecHeurConfig({ projectRoot: root, stateDir: join(root, "state"), env: {} });
	const settled = vi.fn();
	const failure = vi.fn();
	const adapter = new CairnSolverAdapter({
		config,
		cwd: root,
		service,
		evidence,
		runId: "run",
		signal: AbortSignal.timeout(10_000),
		leaseDurationMs: 30_000,
		onSettled: settled,
		onFailure: failure,
		onVerified: vi.fn(),
	});
	const candidate = service.proposeIntent({
		actor: { id: "source", role: "solver", challengeId: "run" },
		idempotencyKey: "propose",
		createdAt: new Date().toISOString(),
		objective: "Read a synthetic record",
		scope: "fixture",
		confidence: 0.5,
	});
	const intent = service.confirmIntent({
		actor: { id: "host", role: "host", challengeId: "run" },
		idempotencyKey: "confirm",
		createdAt: new Date().toISOString(),
		candidateId: candidate.id,
	});
	const lease = service.claimIntent({
		actor: { id: "host", role: "host", challengeId: "run" },
		idempotencyKey: "claim",
		intentId: intent.id,
		solverId: "solver",
		expectedVersion: intent.version,
		leaseDurationMs: 30_000,
	});
	const saved = evidence.save(lease, {
		toolCallId: "fixture",
		toolName: "fixture",
		isError: false,
		result: { content: [{ type: "text", text: "synthetic record" }], details: {} },
	});
	const foreign = evidence.save(
		{ ...lease, challengeId: "other-run" },
		{
			toolCallId: "foreign",
			toolName: "fixture",
			isError: false,
			result: { content: [{ type: "text", text: "foreign fixture" }], details: {} },
		},
	);
	let checked = false;
	const runner = vi.spyOn(subagent, "runPiCodingTask").mockImplementation(async (options) => {
		const tools = new Map<string, TestTool>();
		const handlers: Array<(event: ToolResultEvent) => { isError?: boolean } | undefined> = [];
		const pi = {
			registerTool: (tool: TestTool) => tools.set(tool.name, tool),
			on: (name: string, handler: (event: ToolResultEvent) => { isError?: boolean } | undefined) => {
				if (name === "tool_result") handlers.push(handler);
			},
		} as unknown as ExtensionAPI;
		for (const extension of options.extensionFactories ?? []) {
			if (typeof extension === "function") await extension(pi);
			else await extension.factory(pi);
		}
		const call = async (toolName: string, input: unknown) => {
			const result = await tools.get(toolName)!.execute("call", input);
			const event = {
				type: "tool_result",
				toolCallId: "call",
				toolName,
				input,
				...result,
				isError: false,
			} as ToolResultEvent;
			return { ...result, isError: handlers.some((handler) => handler(event)?.isError === true) };
		};
		const absent = await call("graph_read_evidence", { evidenceId: foreign.evidenceId });
		expect(absent).toMatchObject({
			isError: true,
			details: {
				status: "not_found",
				reasonCode: "cairn_evidence_not_found",
				fieldPaths: ["evidenceId"],
				retryable: true,
				validEvidenceIds: [saved.evidenceId],
				nextTool: { name: "graph_list_evidence" },
			},
		});
		expect(JSON.stringify(absent)).not.toContain(foreign.evidenceId);
		const catalog = await call("graph_list_evidence", { limit: 10 });
		expect(catalog.details).toMatchObject({ items: [{ evidenceId: saved.evidenceId }] });
		expect(await call("graph_read_evidence", { evidenceId: saved.evidenceId })).toMatchObject({
			isError: false,
			details: { evidenceId: saved.evidenceId, complete: true },
		});
		expect(await call("graph_query_record", { section: "intents", id: "invented-record" })).toMatchObject({
			isError: true,
			details: {
				reasonCode: "cairn_record_not_found",
				fieldPaths: ["id"],
				validRecordIds: [intent.id],
				nextTool: { name: "graph_get_context" },
			},
		});
		expect(await call("graph_query_record", { section: "intents", id: intent.id })).toMatchObject({
			isError: false,
			details: { id: intent.id, section: "intents" },
		});
		await call("conclude_intent", { outcome: "inconclusive" });
		checked = true;
		return { messages: [], finalText: "", toolExecutions: [] };
	});
	try {
		await adapter.launch({
			solverId: "solver",
			profileId: "fixture",
			profileFingerprint: "fixture",
			lease,
			handoff: "Synthetic record",
		});
		await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
		expect(checked).toBe(true);
		expect(failure).not.toHaveBeenCalled();
		const diagnostics = evidence
			.events("run")
			.events.filter((event) => event.type === "executor_tool_input_rejected");
		expect(diagnostics).toHaveLength(2);
		expect(diagnostics.map((event) => event.payload.reasonCode)).toEqual([
			"cairn_evidence_not_found",
			"cairn_record_not_found",
		]);
		expect(JSON.stringify(diagnostics)).not.toContain("foreign fixture");
		expect(JSON.stringify(diagnostics)).not.toContain("invented-record");
	} finally {
		runner.mockRestore();
		await adapter.close();
		evidence.close();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
