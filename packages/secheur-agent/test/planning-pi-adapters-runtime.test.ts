import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { compilePlanningProposal } from "../src/planning/compiler.ts";
import { PLANNING_SCHEMA_VERSION, type PlanningSnapshot } from "../src/planning/contracts.ts";
import { PiPlanningSupervisor } from "../src/planning/pi-adapters.ts";
import { runPiCodingTask } from "../src/subagent.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function snapshot(): PlanningSnapshot {
	const now = 1_789_000_000;
	return {
		run: {
			runId: "runtime-dependency-contract",
			outerTaskId: "outer",
			goal: "solve challenge",
			mode: "active",
			status: "running",
			revision: 4,
			createdAt: now,
			updatedAt: now,
		},
		tasks: [
			{
				taskId: "plan_123",
				runId: "runtime-dependency-contract",
				objective: "inspect the target",
				doneWhen: "inspection evidence is persisted",
				status: "done",
				priority: 1,
				sequence: 0,
				dependsOnTaskIds: [],
				createdAt: now,
				updatedAt: now,
			},
		],
		evidence: [],
		executionFrame: {
			runId: "runtime-dependency-contract",
			revision: 4,
			updatedAt: now,
			frame: {
				schemaVersion: PLANNING_SCHEMA_VERSION,
				taskSummaries: [],
				facts: [],
				rejectedDirections: [],
				openQuestions: [],
				artifacts: [],
			},
		},
	};
}

describe("Pi planning supervisor runtime dependency recovery", () => {
	it("repairs an unknown dependency in the same native Pi conversation", async () => {
		const responses = [
			{
				decision: "create_tasks",
				rationale: "next step",
				tasks: [
					{
						key: "verify",
						increment: "Verify the finding from the completed inspection rather than repeat inspection",
						objective: "verify the finding",
						doneWhen: "the finding is verified",
						priority: 1,
						dependsOn: ["inspect"],
					},
				],
				answerEvidenceRefs: [],
			},
			{
				decision: "create_tasks",
				rationale: "next step",
				tasks: [
					{
						key: "verify",
						increment: "Verify the finding from the completed inspection rather than repeat inspection",
						objective: "verify the finding",
						doneWhen: "the finding is verified",
						priority: 1,
						dependsOn: ["plan_123"],
					},
				],
				answerEvidenceRefs: [],
			},
		];
		const requestBodies: Array<{ messages?: Array<{ content?: unknown }>; tools?: unknown[] }> = [];
		const lifecycleEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const server = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += chunk.toString();
			requestBodies.push(JSON.parse(body) as { messages?: Array<{ content?: unknown }> });
			const content = JSON.stringify(responses[requestBodies.length - 1]);
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			response.write(
				`data: ${JSON.stringify({ id: `chatcmpl-${requestBodies.length}`, object: "chat.completion.chunk", created: 0, model: "planning-smoke", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `submit-${requestBodies.length}`, type: "function", function: { name: "submit_planning_proposal", arguments: content } }] }, finish_reason: null }] })}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({ id: `chatcmpl-${requestBodies.length}`, object: "chat.completion.chunk", created: 0, model: "planning-smoke", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");

		const root = mkdtempSync(join(tmpdir(), "planning-runtime-smoke-"));
		temporaryRoots.push(root);
		const stateDir = join(root, ".state");
		const agentDir = join(stateDir, "pi");
		mkdirSync(agentDir, { recursive: true });
		const { port } = server.address() as AddressInfo;
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"planning-smoke": {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						models: [{ id: "planning-smoke", contextWindow: 32_000, maxTokens: 4_096 }],
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ "planning-smoke": { type: "api_key", key: "test-key" } }),
		);
		const model: Model<"openai-completions"> = {
			id: "planning-smoke",
			name: "planning-smoke",
			provider: "planning-smoke",
			api: "openai-completions",
			baseUrl: `http://127.0.0.1:${port}/v1`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 4_096,
		};

		try {
			const planningSnapshot = snapshot();
			const supervisor = new PiPlanningSupervisor({
				config: loadSecHeurConfig({
					projectRoot: root,
					stateDir,
					legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
					env: {},
				}),
				cwd: root,
				model,
				onLifecycleEvent: (type, payload) => lifecycleEvents.push({ type, payload }),
			});
			const proposal = await supervisor.propose({ snapshot: planningSnapshot });

			expect(requestBodies).toHaveLength(2);
			expect(JSON.stringify(requestBodies[0])).toContain("allowedDependencyTaskIds");
			expect(JSON.stringify(requestBodies[0])).toContain("plan_123");
			expect(JSON.stringify(requestBodies[1])).toContain("unknown dependency: inspect");
			expect(proposal.tasks[0]?.dependsOn).toEqual(["plan_123"]);
			expect(() =>
				compilePlanningProposal(planningSnapshot.run.runId, proposal, planningSnapshot.tasks, 8),
			).not.toThrow();
			expect(lifecycleEvents.filter((event) => event.type === "session_create_start")).toHaveLength(1);
			expect(lifecycleEvents.filter((event) => event.type === "planning_submission_rejected")).toHaveLength(1);
			expect(lifecycleEvents.filter((event) => event.type === "planning_submission_staged")).toHaveLength(1);
			expect(requestBodies[1].messages!.length).toBeGreaterThan(requestBodies[0].messages!.length);
			for (const request of requestBodies) expect(JSON.stringify(request.tools)).toContain("planning_query_context");
			for (const event of lifecycleEvents) {
				expect(event.payload).toMatchObject({ runId: planningSnapshot.run.runId, revision: 4 });
				expect(event.payload.elapsedMs).toEqual(expect.any(Number));
			}
		} finally {
			server.close();
			await once(server, "close");
		}
	});

	it("records abort and final settlement for an in-flight Pi prompt", async () => {
		const server = createServer(async (_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-abort",
					object: "chat.completion.chunk",
					created: 0,
					model: "planning-abort",
					choices: [{ index: 0, delta: { role: "assistant", content: "abort smoke" }, finish_reason: null }],
				})}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-abort",
					object: "chat.completion.chunk",
					created: 0,
					model: "planning-abort",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				})}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");

		const root = mkdtempSync(join(tmpdir(), "planning-runtime-abort-"));
		temporaryRoots.push(root);
		const stateDir = join(root, ".state");
		const agentDir = join(stateDir, "pi");
		mkdirSync(agentDir, { recursive: true });
		const { port } = server.address() as AddressInfo;
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"planning-abort": {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						models: [{ id: "planning-abort", contextWindow: 32_000, maxTokens: 4_096 }],
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ "planning-abort": { type: "api_key", key: "test-key" } }),
		);
		const model: Model<"openai-completions"> = {
			id: "planning-abort",
			name: "planning-abort",
			provider: "planning-abort",
			api: "openai-completions",
			baseUrl: `http://127.0.0.1:${port}/v1`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 4_096,
		};
		const controller = new AbortController();
		const lifecycleEvents: string[] = [];

		try {
			await runPiCodingTask({
				config: loadSecHeurConfig({
					projectRoot: root,
					stateDir,
					legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
					env: {},
				}),
				cwd: root,
				model,
				task: "abort smoke",
				signal: controller.signal,
				onLifecycleEvent: (type) => {
					lifecycleEvents.push(type);
					if (type === "assistant_message_start") controller.abort();
				},
			});
		} catch {
			// Aborting an in-flight prompt may reject or settle normally depending on provider timing.
		}

		const abortIndex = lifecycleEvents.indexOf("signal_abort");
		const endIndex = lifecycleEvents.lastIndexOf("coding_task_end");
		expect(lifecycleEvents).toContain("assistant_message_start");
		expect(abortIndex).toBeGreaterThanOrEqual(0);
		expect(endIndex).toBeGreaterThan(abortIndex);
		if (lifecycleEvents.includes("prompt_end")) {
			expect(lifecycleEvents.indexOf("prompt_end")).toBeGreaterThan(abortIndex);
		}

		server.close();
		await once(server, "close");
	});
});
