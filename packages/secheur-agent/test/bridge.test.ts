import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionSnapshot } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	CompetitionChallenge,
	CompetitionPlatformAdapter,
	CompetitionPolicy,
	CompetitionSubmitResult,
} from "../src/competition-adapters.ts";
import { CompetitionBroker } from "../src/competition-broker.ts";
import type { ChallengeSnapshot, SubmissionPolicy } from "../src/competition-protocol.ts";
import { CompetitionStore } from "../src/competition-store.ts";
import { loadSecHeurConfig, type PermissionMode } from "../src/config.ts";
import { PermissionBroker, PermissionController } from "../src/permissions.ts";
import { planningFailure } from "../src/planning/failures.ts";
import type { CreateSecHeurRuntimeOptions } from "../src/runtime.ts";
import type { SchedulerBackend } from "../src/scheduler.ts";
import type { PiSessionRegistration } from "../src/session-registry.ts";

const runtimeFactory = vi.hoisted(() => vi.fn());
vi.mock("../src/runtime.ts", () => ({
	createSecHeurRuntime: runtimeFactory,
}));

import { SecHeurBridge } from "../src/bridge.ts";

const bridges: Array<InstanceType<typeof SecHeurBridge>> = [];
const roots: string[] = [];
const competitionStores: CompetitionStore[] = [];

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function readSseUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) throw new Error(`SSE stream ended before ${marker}`);
		text += decoder.decode(chunk.value, { stream: true });
		if (text.includes(marker)) return text;
	}
}

afterEach(async () => {
	for (const bridge of bridges.splice(0)) await bridge.close();
	for (const store of competitionStores.splice(0)) store.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	runtimeFactory.mockReset();
});

function createPersistedSession(root: string): { id: string; path: string } {
	const manager = SessionManager.create(root, join(root, ".secheur-agent", "pi", "sessions", "fixture"));
	manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "hello from pi" }],
		api: "openai-completions",
		provider: "openai",
		model: "fixture",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	manager.appendSessionInfo("Persisted session");
	return { id: manager.getSessionId(), path: manager.getSessionFile()! };
}

describe("desktop bridge", () => {
	it("pins all four PLAN engines across preference changes, runtime reload and bridge restart", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-plan-selection-"));
		roots.push(root);
		mkdirSync(join(root, ".secheur-agent"), { recursive: true });
		writeFileSync(
			join(root, ".secheur-agent", "desktop-config.json"),
			JSON.stringify({ theme: "dark", planning: { engine: "hypothesis", leaseTtlSeconds: 900 } }),
		);
		runtimeFactory.mockImplementation(async (options: CreateSecHeurRuntimeOptions) => {
			const file = options.sessionFile
				? { path: options.sessionFile, id: SessionManager.open(options.sessionFile).getSessionId() }
				: createPersistedSession(root);
			const permissions = new PermissionController("default");
			return {
				config: loadSecHeurConfig(options),
				state: {
					permissions,
					permissionBroker: permissions.broker,
					getTurnCount: () => 0,
					getLastJudge: () => undefined,
					close: () => undefined,
				},
				session: {
					messages: [],
					sessionId: file.id,
					sessionFile: file.path,
					setSessionName: vi.fn(),
					modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
					getAllTools: () => [],
					getActiveToolNames: () => [],
					abort: async () => undefined,
				},
				subscribe: () => () => {},
				prompt: async () => undefined,
				setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
				setMemoryReferenceEnabled: () => undefined,
				setKnowledgeBaseEnabled: () => undefined,
				setWebVerbsEnabled: () => undefined,
				dispose: () => undefined,
			};
		});
		const open = async () => {
			const bridge = new SecHeurBridge({
				projectRoot: root,
				port: 0,
				schedulerBackend: false,
				worklist: false,
				competition: false,
			});
			bridges.push(bridge);
			await bridge.listen();
			return { bridge, base: `http://127.0.0.1:${bridge.address.port}` };
		};
		const first = await open();
		const post = (base: string, path: string, body: unknown) =>
			fetch(base + path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const sessions = [];
		for (const engine of ["progressive", "cairn", "hypothesis", "artex"]) {
			expect((await post(first.base, "/planning/options", { engine })).status).toBe(200);
			const created = (await post(first.base, "/session/new", {
				planningEngine: engine,
				executionMode: "plan_multi",
				executionCapacity: 2,
			}).then((r) => r.json())) as { sessionId: string; session: { sessionFile: string } };
			expect(created.session).toMatchObject({ planningEngine: engine, executionMode: "plan_multi" });
			expect(runtimeFactory.mock.calls.at(-1)?.[0]).toMatchObject({ planningEngine: engine });
			sessions.push({ id: created.sessionId, engine, file: created.session.sessionFile });
		}
		const configPath = join(root, ".secheur-agent", "desktop-config.json");
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			theme: "dark",
			planning: { engine: "hypothesis", leaseTtlSeconds: 900 },
			newSessionPlanningEngine: "artex",
		});
		expect((await post(first.base, "/planning/options", { engine: "invalid" })).status).toBe(400);
		expect((await post(first.base, "/session/new", { planningEngine: "invalid" })).status).toBe(400);
		const originalFile = readFileSync(sessions[0]!.file, "utf8");
		await post(first.base, `/session/${sessions[0]!.id}/runtime/reset`, {});
		expect((await fetch(`${first.base}/session/${sessions[0]!.id}/tools`)).status).toBe(200);
		expect(runtimeFactory.mock.calls.at(-1)?.[0]).toMatchObject({ planningEngine: "progressive" });
		await first.bridge.close();
		bridges.splice(bridges.indexOf(first.bridge), 1);
		const restarted = await open();
		const restored = (await fetch(`${restarted.base}/sessions`).then((r) => r.json())) as {
			sessions: Array<{ id: string }>;
		};
		for (const item of sessions) {
			expect(restored.sessions.find((s: { id: string }) => s.id === item.id)).toMatchObject({
				planningEngine: item.engine,
				executionMode: "plan_multi",
				executionCapacity: 2,
			});
		}
		expect((await fetch(`${restarted.base}/session/${sessions[0]!.id}/tools`)).status).toBe(200);
		expect(runtimeFactory.mock.calls.at(-1)?.[0]).toMatchObject({
			planningEngine: "progressive",
			executionMode: "plan_multi",
			executionCapacity: 2,
		});
		expect(readFileSync(sessions[0]!.file, "utf8")).toBe(originalFile);
	});
	it("marks an unverified CTF clean end as unverified idle and preserves verified true", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-ctf-continuation-test-"));
		roots.push(root);
		const permissions = new PermissionController("default");
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		let promptCount = 0;
		runtimeFactory.mockImplementation(async (options: CreateSecHeurRuntimeOptions) => ({
			config: {} as never,
			getBudgetStatus: () => ({ stopped: false }),
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages: [],
				sessionId: "ctf-continuation-session",
				sessionFile: undefined,
				sessionName: undefined,
				setSessionName: vi.fn(),
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
				abort: async () => undefined,
			},
			extensionsResult: {} as never,
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			prompt: async () => {
				promptCount += 1;
				if (options.ctfContinuation) options.ctfContinuation.consecutiveNoToolTurns = 3;
				if (promptCount === 2 || promptCount === 3) {
					for (const listener of listeners) {
						listener({
							type: "tool_execution_end",
							toolCallId: "verify-call-1",
							toolName: "verify_flag",
							result: {
								details: {
									data:
										promptCount === 3
											? { ok: true, verified: true, status: "correct" }
											: { ok: true, verified: false, status: "incorrect" },
								},
							},
							isError: false,
						});
					}
				}
			},
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		}));
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			worklist: false,
			competition: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				cwd: root,
				persist: false,
				taskKind: "ctf",
				targetId: "cybench/bridge-target",
				runId: "field-run-bridge",
			}),
		}).then((response) => response.json())) as { sessionId: string };
		expect(runtimeFactory.mock.calls[0]?.[0]).toMatchObject({
			trustedTaskIdentity: { challengeId: "cybench/bridge-target", runId: "field-run-bridge" },
			requireTrustedChallengeId: true,
		});

		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "solve" }),
		});
		await vi.waitFor(async () => {
			const snapshot = await fetch(`${base}/session/${created.sessionId}`).then((response) => response.json());
			expect(snapshot).toMatchObject({
				session: {
					status: "idle",
					terminalReason: "unverified_idle",
					verificationState: "not_attempted",
					consecutiveNoToolTurns: 3,
				},
			});
		});

		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "verify" }),
		});
		await vi.waitFor(async () => {
			const snapshot = await fetch(`${base}/session/${created.sessionId}`).then((response) => response.json());
			expect(snapshot).toMatchObject({
				session: {
					status: "idle",
					terminalReason: "unverified_idle",
					verificationState: "not_attempted",
					consecutiveNoToolTurns: 3,
				},
			});
		});

		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "verify again" }),
		});
		await vi.waitFor(async () => {
			const snapshot = await fetch(`${base}/session/${created.sessionId}`).then((response) => response.json());
			expect(snapshot).toMatchObject({
				session: {
					status: "idle",
					terminalReason: "verified_true",
					verificationState: "accepted",
					consecutiveNoToolTurns: 3,
				},
			});
		});
	});

	it("does not carry a trusted Field identity between sequential CTF sessions", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-identity-isolation-test-"));
		roots.push(root);
		const permissions = new PermissionController("default");
		runtimeFactory.mockImplementation(async () => ({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages: [],
				sessionId: `sequential-identity-${runtimeFactory.mock.calls.length}`,
				sessionFile: undefined,
				sessionName: undefined,
				setSessionName: vi.fn(),
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
				abort: async () => undefined,
			},
			extensionsResult: {} as never,
			subscribe: () => () => {},
			prompt: async () => undefined,
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		}));
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			worklist: false,
			competition: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const create = async (targetId: string, runId: string) =>
			(await fetch(`${base}/session/new`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ cwd: root, persist: false, taskKind: "ctf", targetId, runId }),
			}).then((response) => response.json())) as { sessionId: string };

		const first = await create("cybench/first-target", "field-run-first");
		const second = await create("cybench/second-target", "field-run-second");
		expect(first.sessionId).not.toBe(second.sessionId);
		expect(runtimeFactory).toHaveBeenCalledTimes(2);
		expect(runtimeFactory.mock.calls[0]?.[0]).toMatchObject({
			trustedTaskIdentity: { challengeId: "cybench/first-target", runId: "field-run-first" },
			requireTrustedChallengeId: true,
		});
		expect(runtimeFactory.mock.calls[1]?.[0]).toMatchObject({
			trustedTaskIdentity: { challengeId: "cybench/second-target", runId: "field-run-second" },
			requireTrustedChallengeId: true,
		});
		expect(runtimeFactory.mock.calls[1]?.[0]).not.toMatchObject({
			trustedTaskIdentity: { challengeId: "cybench/first-target", runId: "field-run-first" },
		});
	});

	it("maps structured Planning failure metadata to planning_failed", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-planning-failure-test-"));
		roots.push(root);
		const permissions = new PermissionController("default");
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		runtimeFactory.mockImplementation(async () => ({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages: [],
				sessionId: "planning-failure-session",
				sessionFile: undefined,
				sessionName: undefined,
				setSessionName: vi.fn(),
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
				abort: async () => undefined,
			},
			extensionsResult: {} as never,
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			prompt: async () => {
				for (const listener of listeners) {
					listener({
						type: "message_end",
						message: {
							role: "custom",
							customType: "progressive-planning-failure",
							content: "Model response did not contain a valid JSON object",
							display: false,
							details: {
								runId: "planning-failure-run",
								failureSource: "planning",
								failureStage: "supervisor_parse",
								failureCode: "supervisor_parse_error",
							},
							timestamp: Date.now(),
						},
					} as AgentSessionEvent);
				}
			},
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		}));
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			worklist: false,
			competition: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false, taskKind: "ctf" }),
		}).then((response) => response.json())) as { sessionId: string };

		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "planning failure" }),
		});
		await vi.waitFor(async () => {
			const response = await fetch(`${base}/session/${created.sessionId}`).then((item) => item.json());
			expect(response).toMatchObject({
				session: {
					status: "error",
					terminalReason: "planning_failed",
					verificationState: "not_attempted",
					failureSource: "planning",
					failureStage: "supervisor_parse",
					failureCode: "supervisor_parse_error",
					lastError: "Model response did not contain a valid JSON object",
				},
			});
		});
	});

	it("falls back to typed Planning failure metadata when runtime notification fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-planning-failure-fallback-test-"));
		roots.push(root);
		const permissions = new PermissionController("default");
		runtimeFactory.mockImplementation(async () => ({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages: [],
				sessionId: "planning-failure-fallback-session",
				sessionFile: undefined,
				sessionName: undefined,
				setSessionName: vi.fn(),
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
				abort: async () => undefined,
			},
			extensionsResult: {} as never,
			subscribe: () => () => undefined,
			prompt: async () => {
				throw planningFailure(
					"supervisor_parse",
					"supervisor_parse_error",
					"Model response did not contain a valid JSON object",
				);
			},
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		}));
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			worklist: false,
			competition: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false, taskKind: "ctf" }),
		}).then((response) => response.json())) as { sessionId: string };

		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "planning failure fallback" }),
		});
		await vi.waitFor(async () => {
			const response = await fetch(`${base}/session/${created.sessionId}`).then((item) => item.json());
			expect(response).toMatchObject({
				session: {
					status: "error",
					terminalReason: "planning_failed",
					verificationState: "not_attempted",
					failureSource: "planning",
					failureStage: "supervisor_parse",
					failureCode: "supervisor_parse_error",
					lastError: "Model response did not contain a valid JSON object",
				},
			});
		});
	});

	it("observes and controls competition tasks through the broker", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-competition-test-"));
		roots.push(root);
		const store = await CompetitionStore.open(":memory:");
		competitionStores.push(store);
		const challenge: ChallengeSnapshot = {
			exerciseId: 10756,
			name: "local pwn",
			category: "pwn",
			description: "A broker fixture",
			hints: [],
			flagFormat: { prefix: "FLAG{", suffix: "}", accepts: "either", submit: "full" },
			attachments: [],
			environment: { required: false, status: "none", endpoints: [] },
			scoring: {
				currentScore: 100,
				challengeValue: 100,
				estimatedSolveProbability: 0.2,
				confidence: 0,
				expectedRemainingMinutes: 10,
				environmentWaitMinutes: 0,
				agingBonus: 0,
				asOf: Date.now(),
			},
			platform: {},
		};
		const submission: SubmissionPolicy = {
			flagFormat: challenge.flagFormat,
			maxAttempts: 2,
			duplicateScope: "challenge",
			acceptedStatuses: ["correct"],
		};
		const adapter: CompetitionPlatformAdapter = {
			platform: "bridge-fixture",
			getPolicy: async (): Promise<CompetitionPolicy> => ({
				flagFormat: challenge.flagFormat,
				submission,
				maxEnvironmentSlots: 1,
				raw: {},
			}),
			listChallenges: async () => [],
			getChallenge: async (): Promise<CompetitionChallenge> => ({ ...challenge, isOpen: true, hasSolved: false }),
			startEnvironment: async () => ({ status: "ready", endpoints: [], leaseMetadata: {}, raw: {} }),
			getEnvironment: async () => ({ status: "ready", endpoints: [], leaseMetadata: {}, raw: {} }),
			submitFlag: async (): Promise<CompetitionSubmitResult> => ({
				isCorrect: false,
				requestPayload: {},
				rawResponse: {},
			}),
			releaseEnvironment: async () => ({}),
		};
		const broker = CompetitionBroker.from({ store, adapter, ownerId: "bridge-fixture" });
		broker.registerTask({
			taskId: "bridge-fixture:10756",
			shortTask: "pwn: local pwn",
			challenge,
			submission,
			policySnapshotId: "policy",
			priority: 10,
		});
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			worklist: false,
			competition: broker,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;

		const status = await fetch(`${base}/competition`).then((response) => response.json());
		expect(status).toMatchObject({ ok: true, platform: "bridge-fixture" });
		const tasks = await fetch(`${base}/competition/tasks`).then((response) => response.json());
		expect(tasks).toEqual([expect.objectContaining({ taskId: "bridge-fixture:10756", priority: 10 })]);
		const planned = await fetch(`${base}/competition/plan`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				taskIds: ["bridge-fixture:10756"],
				rationale: "Run the operator-selected challenge first.",
			}),
		});
		expect(planned.status).toBe(200);
		const plannedPayload = (await planned.json()) as { plan: Record<string, unknown> };
		expect(plannedPayload.plan).toMatchObject({ revision: 1, orderedTaskIds: ["bridge-fixture:10756"] });
		const plan = (await fetch(`${base}/competition/plan`).then((response) => response.json())) as {
			plan: Record<string, unknown>;
		};
		expect(plan.plan).toMatchObject({ revision: 1, orderedTaskIds: ["bridge-fixture:10756"] });
		const stopped = await fetch(`${base}/competition/tasks/bridge-fixture%3A10756/stop`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ reason: "operator test" }),
		});
		expect(stopped.status).toBe(200);
		const stoppedPayload = (await stopped.json()) as { task?: Record<string, unknown> };
		expect(stoppedPayload.task).toMatchObject({ status: "stopped", lastError: "operator test" });
		const requeued = await fetch(`${base}/competition/tasks/bridge-fixture%3A10756/requeue`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ reason: "resume operator test" }),
		});
		expect(requeued.status).toBe(200);
		expect((await requeued.json()) as Record<string, unknown>).toMatchObject({
			tasks: [expect.objectContaining({ status: "queued" })],
		});
	});

	it("exposes Worklist operator guide and stop controls", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-worklist-control-test-"));
		roots.push(root);
		const summary = { ok: true, running: true, configured: true, items: [] };
		const guideItem = vi.fn(async () => summary);
		const stopItem = vi.fn(async () => summary);
		const worklist = {
			start: vi.fn(async () => summary),
			stop: vi.fn(async () => undefined),
			refresh: vi.fn(async () => summary),
			retry: vi.fn(async () => summary),
			guideItem,
			stopItem,
			publicSummary: () => summary,
			store: { close: vi.fn() },
		};
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			worklist: worklist as never,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;

		const guideResponse = await fetch(`${base}/worklist/item-1/guide`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "Inspect the crash trace" }),
		});
		const stopResponse = await fetch(`${base}/worklist/item-1/stop`, { method: "POST" });

		expect(guideResponse.status).toBe(200);
		expect(stopResponse.status).toBe(200);
		expect(guideItem).toHaveBeenCalledWith("item-1", "Inspect the crash trace");
		expect(stopItem).toHaveBeenCalledWith("item-1");
	});

	it("returns the slash commands exposed by the active Pi runtime", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-commands-test-"));
		roots.push(root);
		const permissions = new PermissionController("default");
		const commands = [
			{ name: "model", description: "Select model", argumentHint: "<provider/model>", source: "builtin" },
			{ name: "extension-demo", description: "Extension command", source: "extension" },
			{ name: "skill:forensics", description: "Forensics skill", source: "skill" },
		];
		const getCommands = vi.fn(() => commands);
		runtimeFactory.mockResolvedValue({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages: [],
				sessionId: "commands-session",
				sessionFile: undefined,
				sessionName: undefined,
				setSessionName: vi.fn(),
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
				abort: async () => undefined,
			},
			extensionsResult: {} as never,
			subscribe: () => () => undefined,
			prompt: async () => undefined,
			getCommands,
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		} as never);

		const bridge = new SecHeurBridge({ projectRoot: root, port: 0, schedulerBackend: false });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };
		const response = await fetch(`${base}/session/${created.sessionId}/commands`);
		const payload = (await response.json()) as { sessionId: string; commands: typeof commands };

		expect(response.status).toBe(200);
		expect(payload).toEqual({ sessionId: created.sessionId, commands });
		expect(getCommands).toHaveBeenCalledOnce();
	});

	it("executes stateful Pi slash commands through the active runtime", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-command-test-"));
		roots.push(root);
		const permissions = new PermissionController("default");
		const manager = SessionManager.inMemory(root, { id: "command-session" });
		manager.appendMessage({ role: "user", content: "inspect target", timestamp: 1 });
		const setSessionName = vi.fn();
		const compact = vi.fn(async (instructions?: string) => ({
			summary: "compacted",
			firstKeptEntryId: "entry-1",
			tokensBefore: 1200,
			estimatedTokensAfter: 300,
			instructions,
		}));
		const reload = vi.fn(async () => undefined);
		const originalUi = { notify: vi.fn() };
		let activeUi = originalUi;
		const setUIContext = vi.fn((ui: typeof originalUi) => {
			activeUi = ui;
		});
		const extensionPrompt = vi.fn(async (prompt: string) => {
			activeUi.notify(`Extension handled ${prompt}`, "info");
		});
		const getSessionStats = vi.fn(() => ({
			sessionFile: undefined,
			sessionId: manager.getSessionId(),
			userMessages: 1,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 1,
			tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 },
			cost: 0.01,
		}));
		runtimeFactory.mockResolvedValue({
			config: { agentDir: join(root, ".secheur-agent", "pi") },
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages: [],
				sessionId: manager.getSessionId(),
				sessionFile: undefined,
				sessionName: undefined,
				sessionManager: manager,
				setSessionName,
				getSessionStats,
				compact,
				reload,
				prompt: extensionPrompt,
				extensionRunner: {
					getUIContext: () => originalUi,
					setUIContext,
				},
				navigateTree: vi.fn(),
				getUserMessagesForForking: vi.fn(() => []),
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
				abort: async () => undefined,
			},
			extensionsResult: {} as never,
			subscribe: () => () => undefined,
			prompt: async () => undefined,
			getCommands: () => [{ name: "extension-demo", source: "extension" }],
			getBudgetStatus: () => null,
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		} as never);

		const bridge = new SecHeurBridge({ projectRoot: root, port: 0, schedulerBackend: false });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };
		const command = (name: string, argument = "") =>
			fetch(`${base}/session/${created.sessionId}/command`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ command: name, argument }),
			});

		const renamed = await command("name", "Web command session");
		expect(renamed.status).toBe(200);
		expect(await renamed.json()).toMatchObject({ ok: true, command: "name", title: "Web command session" });
		expect(setSessionName).toHaveBeenLastCalledWith("Web command session");

		const stats = await command("session");
		expect(await stats.json()).toMatchObject({ stats: { totalMessages: 1, tokens: { total: 12 } } });
		expect(getSessionStats).toHaveBeenCalledOnce();

		const compacted = await command("compact", "keep exploit evidence");
		expect(await compacted.json()).toMatchObject({
			result: { summary: "compacted", tokensBefore: 1200, estimatedTokensAfter: 300 },
		});
		expect(compact).toHaveBeenCalledWith("keep exploit evidence");

		const reloaded = await command("reload");
		expect(reloaded.status).toBe(200);
		expect(reload).toHaveBeenCalledOnce();

		const invoked = await fetch(`${base}/session/${created.sessionId}/command`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ command: "invoke", target: "extension-demo", argument: "proof" }),
		});
		expect(await invoked.json()).toMatchObject({
			ok: true,
			command: "invoke",
			target: "extension-demo",
			notifications: [{ type: "info", message: "Extension handled /extension-demo proof" }],
		});
		expect(extensionPrompt).toHaveBeenCalledWith("/extension-demo proof");
		expect(setUIContext).toHaveBeenLastCalledWith(originalUi, "print");

		const tree = await command("tree");
		expect(await tree.json()).toMatchObject({
			command: "tree",
			entries: [expect.objectContaining({ type: "message", role: "user", text: "inspect target" })],
		});
	});

	it("runs scheduled work in a dedicated session without replacing the active user session", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-scheduler-test-"));
		roots.push(root);
		const checkGate = deferred();
		const done = vi.fn(async () => undefined);
		const check = vi.fn(async () => {
			await checkGate.promise;
			return { available: true, task: "[定时任务] demo\n执行测试任务", intervalSeconds: 120 };
		});
		const schedulerBackend: SchedulerBackend = { check, done, close: vi.fn() };
		let runtimeCount = 0;
		runtimeFactory.mockImplementation(async () => {
			runtimeCount += 1;
			const sessionId = `scheduler-test-${runtimeCount}`;
			const messages: Array<Record<string, unknown>> = [];
			const permissions = new PermissionController("default");
			return {
				config: {} as never,
				state: {
					permissions,
					permissionBroker: permissions.broker,
					getTurnCount: () => 0,
					getLastJudge: () => undefined,
					close: () => undefined,
				},
				session: {
					messages,
					sessionId,
					sessionFile: undefined,
					sessionName: undefined,
					setSessionName: vi.fn(),
					modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
					abort: async () => undefined,
				},
				extensionsResult: {} as never,
				subscribe: () => () => undefined,
				prompt: async (prompt: string) => {
					messages.push({ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() });
					messages.push({
						role: "assistant",
						content: [{ type: "text", text: "报告已完成" }],
						stopReason: "stop",
						timestamp: Date.now(),
					});
				},
				setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
				setMemoryReferenceEnabled: () => undefined,
				setKnowledgeBaseEnabled: () => undefined,
				setWebVerbsEnabled: () => undefined,
				dispose: () => undefined,
			} as never;
		});
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0, schedulerBackend });
		bridges.push(bridge);
		await bridge.listen();
		await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, title: "用户会话", persist: false }),
		}).then((response) => response.json())) as { sessionId: string };

		checkGate.resolve();
		await vi.waitFor(() => expect(done).toHaveBeenCalledWith("报告已完成"));
		const sessions = (await fetch(`${base}/sessions`).then((response) => response.json())) as {
			activeSessionId: string;
			sessions: Array<{ id: string; title: string }>;
		};
		expect(sessions.activeSessionId).toBe(created.sessionId);
		const schedulerSession = sessions.sessions.find((session) => session.title === "定时任务");
		expect(schedulerSession?.id).toBeTruthy();
		const scheduledMessages = (await fetch(`${base}/session/${schedulerSession?.id}/messages`).then((response) =>
			response.json(),
		)) as { status: string; messages: Array<Record<string, unknown>> };
		expect(scheduledMessages.status).toBe("idle");
		expect(scheduledMessages.messages).toEqual([
			expect.objectContaining({ role: "user", source: "scheduler", content: expect.stringContaining("demo") }),
			expect.objectContaining({ role: "assistant", content: "报告已完成" }),
		]);
		await fetch(`${base}/session/${created.sessionId}`, { method: "DELETE" });
		const afterUserClose = (await fetch(`${base}/sessions`).then((response) => response.json())) as {
			activeSessionId: string | null;
		};
		expect(afterUserClose.activeSessionId).toBeNull();
	});

	it("runs the next scheduled task after the previous task fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-scheduler-retry-test-"));
		roots.push(root);
		const check = vi.fn(async () => ({
			available: true,
			task: "[定时任务] retry",
			intervalSeconds: 120,
		}));
		const done = vi.fn(async () => undefined);
		const schedulerBackend: SchedulerBackend = { check, done, close: vi.fn() };
		const messages: Array<Record<string, unknown>> = [];
		const permissions = new PermissionController("default");
		let promptCount = 0;
		runtimeFactory.mockResolvedValue({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages,
				sessionId: "scheduler-retry-session",
				sessionFile: undefined,
				sessionName: undefined,
				setSessionName: vi.fn(),
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
				abort: async () => undefined,
			},
			extensionsResult: {} as never,
			subscribe: () => () => undefined,
			prompt: async (prompt: string) => {
				promptCount += 1;
				if (promptCount === 1) throw new Error("scheduled task failed");
				messages.push({ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() });
				messages.push({
					role: "assistant",
					content: [{ type: "text", text: "retry completed" }],
					stopReason: "stop",
					timestamp: Date.now(),
				});
			},
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		} as never);
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0, schedulerBackend });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		await vi.waitFor(async () => {
			const sessions = (await fetch(`${base}/sessions`).then((response) => response.json())) as {
				sessions: Array<{ status: string; title: string }>;
			};
			expect(sessions.sessions.find((session) => session.title === "定时任务")?.status).toBe("error");
		});

		const scheduler = (bridge as unknown as { scheduler: { tick(): Promise<unknown> } }).scheduler;
		await expect(scheduler.tick()).resolves.toMatchObject({ submitted: true });
		await vi.waitFor(() => expect(done).toHaveBeenCalledWith("retry completed"));
		expect(check).toHaveBeenCalledTimes(2);
		expect(promptCount).toBe(2);
	});

	it("disposes a session runtime acquired while the bridge is closing", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-close-acquisition-test-"));
		roots.push(root);
		const releaseRuntime = deferred();
		const dispose = vi.fn();
		const permissions = new PermissionController("default");
		runtimeFactory.mockImplementation(async () => {
			await releaseRuntime.promise;
			return {
				config: {} as never,
				state: {
					permissions,
					permissionBroker: permissions.broker,
					getTurnCount: () => 0,
					getLastJudge: () => undefined,
					close: () => undefined,
				},
				session: {
					messages: [],
					sessionId: "bridge-close-acquisition",
					sessionFile: undefined,
					sessionName: undefined,
					setSessionName: vi.fn(),
					modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
					abort: async () => undefined,
				},
				extensionsResult: {} as never,
				subscribe: () => () => undefined,
				prompt: async () => undefined,
				setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
				setMemoryReferenceEnabled: () => undefined,
				setKnowledgeBaseEnabled: () => undefined,
				setWebVerbsEnabled: () => undefined,
				dispose,
			} as never;
		});
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0, schedulerBackend: false });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const creating = fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		});
		await vi.waitFor(() => expect(runtimeFactory).toHaveBeenCalledTimes(1));
		const closing = bridge.close();
		releaseRuntime.resolve();
		expect((await creating).status).toBe(201);
		await closing;
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("serves status, registry, and resource configuration routes", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-test-"));
		roots.push(root);
		const pluginRoot = join(root, "fixture-pi-plugin");
		mkdirSync(pluginRoot);
		mkdirSync(join(pluginRoot, "desktop"));
		writeFileSync(join(root, "outside-plugin.css"), ".outside { color: red; }\n");
		writeFileSync(
			join(pluginRoot, "package.json"),
			JSON.stringify({
				name: "fixture-pi-plugin",
				version: "1.0.0",
				pi: { extensions: ["./index.ts"] },
				secheur: {
					desktop: {
						styles: ["./desktop/conversation.css", "../outside-plugin.css"],
						scripts: ["./desktop/conversation.js"],
					},
				},
			}),
		);
		writeFileSync(join(pluginRoot, "index.ts"), "export default function fixturePlugin() {}\n");
		writeFileSync(join(pluginRoot, "desktop", "conversation.css"), ".fixture-trace { display: block; }\n");
		writeFileSync(join(pluginRoot, "desktop", "conversation.js"), "window.fixtureTraceLoaded = true;\n");
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0 });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;

		const status = await fetch(`${base}/status`).then((response) => response.json());
		expect(status).toMatchObject({ ok: true, ready: true, projectRoot: root });

		const skill = await fetch(`${base}/skill-config`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ config: { name: "bridge-skill", body: "Use bridge evidence." } }),
		}).then((response) => response.json());
		expect(skill).toMatchObject({ ok: true, saved: { name: "bridge-skill" } });

		const registry = (await fetch(`${base}/registry`).then((response) => response.json())) as { skills?: unknown[] };
		expect(registry.skills).toEqual(expect.arrayContaining([expect.objectContaining({ name: "bridge-skill" })]));

		const deleted = await fetch(`${base}/skill-config/bridge-skill`, { method: "DELETE" }).then((response) =>
			response.json(),
		);
		expect(deleted).toMatchObject({ ok: true, deleted: { name: "bridge-skill" } });

		const installed = (await fetch(`${base}/plugins/install`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: pluginRoot, scope: "user" }),
		}).then((response) => response.json())) as {
			plugins: Array<{
				source: string;
				scope: string;
				enabled: boolean;
				resources: { extensions: number };
				desktopUi: { styles: number; scripts: number };
				diagnostics: string[];
			}>;
		};
		expect(installed.plugins).toEqual([
			expect.objectContaining({
				name: "fixture-pi-plugin",
				scope: "user",
				enabled: true,
				installed: true,
				resources: expect.objectContaining({ extensions: 1 }),
				desktopUi: { styles: 1, scripts: 1 },
				diagnostics: [expect.stringContaining("Invalid Desktop UI styles path")],
			}),
		]);
		const plugin = installed.plugins[0];
		const desktopUi = (await fetch(`${base}/plugins/ui`).then((response) => response.json())) as {
			plugins: Array<{ id: string; name: string; styles: string[]; scripts: string[] }>;
		};
		expect(desktopUi.plugins).toEqual([
			expect.objectContaining({
				name: "fixture-pi-plugin",
				styles: [expect.stringMatching(/^\/plugins\/ui-assets\/[a-f0-9]{24}\/styles\/0$/u)],
				scripts: [expect.stringMatching(/^\/plugins\/ui-assets\/[a-f0-9]{24}\/scripts\/0$/u)],
			}),
		]);
		const uiPlugin = desktopUi.plugins[0];
		const stylesheet = await fetch(`${base}${uiPlugin.styles[0]}`);
		expect(stylesheet.status).toBe(200);
		expect(stylesheet.headers.get("content-type")).toBe("text/css; charset=utf-8");
		expect(await stylesheet.text()).toContain(".fixture-trace");
		const script = await fetch(`${base}${uiPlugin.scripts[0]}`, { method: "HEAD" });
		expect(script.status).toBe(200);
		expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(await script.text()).toBe("");
		const pluginTraversal = await fetch(
			`${base}/plugins/ui-assets/${uiPlugin.id}/styles/..%2F..%2Foutside-plugin.css`,
		);
		expect(pluginTraversal.status).toBe(404);
		const disabled = await fetch(`${base}/plugins/toggle`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: plugin.source, scope: plugin.scope, enabled: false }),
		}).then((response) => response.json());
		expect(disabled).toMatchObject({
			ok: true,
			plugins: [expect.objectContaining({ name: "fixture-pi-plugin", enabled: false })],
		});
		expect(await fetch(`${base}${uiPlugin.styles[0]}`).then((response) => response.status)).toBe(404);
		expect(await fetch(`${base}/plugins/ui`).then((response) => response.json())).toMatchObject({ plugins: [] });
		const removed = await fetch(`${base}/plugins/remove`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: plugin.source, scope: plugin.scope }),
		}).then((response) => response.json());
		expect(removed).toMatchObject({ ok: true, plugins: [] });
	});

	it("reloads a running session after registry changes without interrupting its current prompt", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-registry-reload-test-"));
		roots.push(root);
		const firstPrompt = deferred();
		const firstDispose = vi.fn();
		const secondDispose = vi.fn();
		const firstAbort = vi.fn(async () => undefined);
		const secondPrompt = vi.fn(async () => undefined);
		const makeRuntime = (
			prompt: (value: string) => Promise<void>,
			dispose: () => void,
			abort: () => Promise<void>,
		) => {
			const permissions = new PermissionController("default");
			return {
				config: {} as never,
				state: {
					permissions,
					permissionBroker: permissions.broker,
					getTurnCount: () => 0,
					getLastJudge: () => undefined,
					close: () => undefined,
				},
				session: {
					messages: [],
					sessionId: "registry-reload-session",
					sessionFile: undefined,
					sessionName: undefined,
					setSessionName: vi.fn(),
					modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
					abort,
				},
				extensionsResult: {} as never,
				subscribe: () => () => undefined,
				prompt,
				setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
				setMemoryReferenceEnabled: () => undefined,
				setKnowledgeBaseEnabled: () => undefined,
				setWebVerbsEnabled: () => undefined,
				dispose,
			} as never;
		};
		runtimeFactory
			.mockResolvedValueOnce(makeRuntime(() => firstPrompt.promise, firstDispose, firstAbort))
			.mockResolvedValueOnce(makeRuntime(secondPrompt, secondDispose, async () => undefined));
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0 });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };

		const invalid = await fetch(`${base}/registry`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ tools: [] }),
		});
		expect(invalid.status).toBe(400);
		expect(firstDispose).not.toHaveBeenCalled();

		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "before registry change" }),
		});
		const registry = await fetch(`${base}/registry`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ tools: { bash: false } }),
		}).then((response) => response.json());
		expect(registry).toMatchObject({ ok: true, runtimeReloadPending: 1 });
		expect(firstAbort).not.toHaveBeenCalled();
		expect(firstDispose).not.toHaveBeenCalled();

		firstPrompt.resolve();
		await vi.waitFor(() => expect(firstDispose).toHaveBeenCalledTimes(1));
		const settled = (await fetch(`${base}/session/${created.sessionId}/messages`).then((response) =>
			response.json(),
		)) as { runtimeReloadPending: boolean; status: string };
		expect(settled).toMatchObject({ runtimeReloadPending: false, status: "idle" });

		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "after registry change" }),
		});
		await vi.waitFor(() => expect(secondPrompt).toHaveBeenCalledWith("after registry change", { images: [] }));
		expect(runtimeFactory).toHaveBeenCalledTimes(2);
	});

	it("discovers API models before a profile name or model is selected", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-api-models-test-"));
		roots.push(root);
		let authorization = "";
		const api = createServer((request, response) => {
			authorization = request.headers.authorization ?? "";
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "fixture-model", name: "Fixture Model" }] }));
		});
		await new Promise<void>((resolveListen, reject) => {
			api.once("error", reject);
			api.listen(0, "127.0.0.1", resolveListen);
		});
		try {
			const apiAddress = api.address();
			if (!apiAddress || typeof apiAddress === "string") throw new Error("API fixture has no TCP address");
			const bridge = new SecHeurBridge({ projectRoot: root, port: 0 });
			bridges.push(bridge);
			await bridge.listen();
			const response = await fetch(`http://127.0.0.1:${bridge.address.port}/api-config/models`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					config: {
						type: "native_oai",
						name: "",
						apibase: `http://127.0.0.1:${apiAddress.port}/v1`,
						model: "",
						apikey: "fixture-key",
					},
				}),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				ok: true,
				models: [{ id: "fixture-model", name: "Fixture Model" }],
			});
			expect(authorization).toBe("Bearer fixture-key");
		} finally {
			await new Promise<void>((resolveClose) => api.close(() => resolveClose()));
		}
	});

	it("serves the desktop and benchmark assets without exposing files outside the static roots", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-static-test-"));
		roots.push(root);
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0 });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;

		const index = await fetch(`${base}/`);
		expect(index.status).toBe(200);
		expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
		const indexText = await index.text();
		expect(indexText).toContain("<title>SecHeur Agent</title>");
		expect(indexText).toContain('id="sidebar"');
		expect(indexText).toContain('id="trajectory-viewer"');
		expect(indexText).toMatch(/<a\b[^>]*id="changelog-btn"[^>]*href="\/updates\.html"/u);
		const ids = [...indexText.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
		expect(new Set(ids).size).toBe(ids.length);

		const updates = await fetch(`${base}/updates.html`);
		expect(updates.status).toBe(200);
		expect(updates.headers.get("content-type")).toBe("text/html; charset=utf-8");
		const updatesText = await updates.text();
		expect(updatesText).toContain("<title>更新日志 · SecHeur Agent</title>");
		expect(updatesText).toMatch(/<a\b[^>]*href="\/"[^>]*>[^<]*返回对话\s*<\/a>/u);
		const updatesHead = await fetch(`${base}/updates.html`, { method: "HEAD" });
		expect(updatesHead.status).toBe(200);
		expect(updatesHead.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(updatesHead.headers.get("content-length")).toBe(String(Buffer.byteLength(updatesText)));
		expect(await updatesHead.text()).toBe("");

		const reactIndex = await fetch(`${base}/webui/`);
		expect(reactIndex.status).toBe(200);
		const reactIndexText = await reactIndex.text();
		expect(reactIndexText).toContain('<div id="root"></div>');
		expect(reactIndexText).toContain("/webui/assets/app.js");

		const script = await fetch(`${base}/secheur-web.js`, { method: "HEAD" });
		expect(script.status).toBe(200);
		expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(await script.text()).toBe("");

		const benchmark = await fetch(`${base}/benchmark-dashboard/`);
		expect(benchmark.status).toBe(200);
		const benchmarkText = await benchmark.text();
		expect(benchmarkText).toContain("<title>SecHeur Agent Benchmark Dashboard</title>");
		const imagePaths = [...benchmarkText.matchAll(/<img\s+src="([^"]+)"/gu)].map((match) => match[1]);
		expect(imagePaths).toHaveLength(3);
		for (const imagePath of imagePaths) {
			const image = await fetch(`${base}${imagePath}`);
			expect(image.status).toBe(200);
			expect(image.headers.get("content-type")).toBe("image/png");
			const content = Buffer.from(await image.arrayBuffer());
			expect(content.length).toBeGreaterThan(8);
			expect(content.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
			const head = await fetch(`${base}${imagePath}`, { method: "HEAD" });
			expect(head.status).toBe(200);
			expect(head.headers.get("content-type")).toBe("image/png");
			expect(head.headers.get("content-length")).toBe(String(content.length));
			expect(await head.text()).toBe("");
		}

		const traversal = await fetch(`${base}/..%2fpackage.json`);
		expect(traversal.status).toBe(404);
		const benchmarkTraversal = await fetch(`${base}/benchmark-dashboard/..%2fsecheur_pi_bridge.py`);
		expect(benchmarkTraversal.status).toBe(404);
		const status = await fetch(`${base}/status`);
		expect(status.headers.get("content-type")).toBe("application/json; charset=utf-8");
	});

	it("replays bridge events over SSE and keeps the stream alive for new events", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-sse-test-"));
		roots.push(root);
		const permissions = new PermissionController("default");
		runtimeFactory.mockResolvedValue({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages: [],
				sessionId: "sse-session",
				sessionFile: undefined,
				sessionName: undefined,
				setSessionName: vi.fn(),
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
				abort: async () => undefined,
			},
			extensionsResult: {} as never,
			subscribe: () => () => undefined,
			prompt: async () => undefined,
			setPermissionMode: () => undefined,
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: vi.fn(),
		} as never);
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0, schedulerBackend: false });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };

		const stream = await fetch(`${base}/events?since=0`, { signal: AbortSignal.timeout(5_000) });
		expect(stream.status).toBe(200);
		expect(stream.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
		if (!stream.body) throw new Error("SSE response has no body");
		const reader = stream.body.getReader();
		const replay = await readSseUntil(reader, '"event":"created"');
		expect(replay).toContain("id: 1");
		expect(replay).toContain('"type":"session-state"');

		const activated = await fetch(`${base}/session/${encodeURIComponent(created.sessionId)}/activate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(activated.status).toBe(200);
		const live = await readSseUntil(reader, '"event":"activated"');
		const liveEventId = Number(live.match(/^id: (\d+)$/mu)?.[1] ?? 0);
		expect(liveEventId).toBeGreaterThan(1);
		await reader.cancel();
	});

	it("rejects browser requests from non-local origins", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-origin-test-"));
		roots.push(root);
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0 });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;

		const rejected = await fetch(`${base}/status`, { headers: { Origin: "https://external.example" } });
		expect(rejected.status).toBe(403);
		expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
		expect(await rejected.json()).toEqual({ error: "origin is not allowed" });

		const local = await fetch(`${base}/status`, { headers: { Origin: "http://127.0.0.1:5173" } });
		expect(local.status).toBe(200);
		expect(local.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
	});

	it("preserves prompt display text and forwards image and file attachments to Pi", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-attachment-test-"));
		roots.push(root);
		const permissions = new PermissionController("default");
		const messages: Array<Record<string, unknown>> = [];
		const models = [
			{ provider: "fixture", id: "model-0" },
			{ provider: "fixture", id: "model-1" },
		];
		let selectedModel = models[0];
		const setModel = vi.fn(async (model: (typeof models)[number]) => {
			selectedModel = model;
		});
		const prompt = vi.fn(async (text: string, options?: { images?: unknown[] }) => {
			messages.push({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
				timestamp: Date.now(),
			});
			expect(options?.images).toHaveLength(1);
		});
		const setMemoryReferenceEnabled = vi.fn();
		const setKnowledgeBaseEnabled = vi.fn();
		const setWebVerbsEnabled = vi.fn();
		runtimeFactory.mockResolvedValue({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages,
				sessionId: "attachment-session",
				sessionFile: undefined,
				sessionName: undefined,
				get model() {
					return selectedModel;
				},
				setSessionName: vi.fn(),
				modelRuntime: {
					getAvailableSnapshot: () => models,
					getModels: () => models,
					getModel: (provider: string, id: string) =>
						models.find((model) => model.provider === provider && model.id === id),
				},
				setModel,
				abort: async () => undefined,
			},
			extensionsResult: {} as never,
			subscribe: () => () => undefined,
			prompt,
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled,
			setKnowledgeBaseEnabled,
			setWebVerbsEnabled,
			dispose: () => undefined,
		} as never);
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0 });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };
		const invalid = await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				prompt: "invalid model",
				llmNo: true,
				files: [
					{
						id: "invalid-file",
						name: "invalid.txt",
						dataUrl: Buffer.from("must not be written").toString("base64"),
					},
				],
			}),
		});
		expect(invalid.status).toBe(400);
		expect(existsSync(join(root, ".secheur-agent", "uploads", created.sessionId))).toBe(false);

		const submitted = (await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				prompt: "internal-preface\n\nfix the issue",
				displayPrompt: "fix the issue",
				images: [{ id: "image-1", dataUrl: `data:image/png;base64,${Buffer.from("png").toString("base64")}` }],
				files: [
					{
						id: "file-1",
						name: "notes.txt",
						type: "text/plain",
						dataUrl: `data:text/plain;base64,${Buffer.from("evidence").toString("base64")}`,
					},
				],
				llmNo: 1,
				webVerbsEnabled: true,
			}),
		}).then((response) => response.json())) as Record<string, unknown>;

		expect(submitted).toMatchObject({
			ok: true,
			accepted: true,
			queued: false,
			userMessageId: 1,
			seq: 1,
		});
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
		await vi.waitFor(async () => {
			const polled = (await fetch(`${base}/session/${created.sessionId}/messages`).then((response) =>
				response.json(),
			)) as {
				status: string;
				messages: Array<Record<string, unknown>>;
				blackboardGraph: { project: { origin: string }; facts: unknown[] };
			};
			expect(polled.status).toBe("idle");
			expect(polled.messages).toHaveLength(2);
			expect(polled.messages[0]).toMatchObject({
				id: 1,
				role: "user",
				content: "fix the issue",
				image_ids: ["image-1"],
				file_attachments: [{ id: "file-1", name: "notes.txt", size: 8 }],
			});
			expect(polled.messages[1]).toMatchObject({ id: 2, role: "assistant", content: "done" });
			expect(polled.blackboardGraph.project.origin).toBe("fix the issue");
			expect(polled.blackboardGraph.facts).toHaveLength(3);
		});
		expect(prompt.mock.calls[0]?.[0]).toContain("internal-preface");
		expect(prompt.mock.calls[0]?.[0]).toContain("<uploaded_file");
		expect(setModel).toHaveBeenCalledWith(models[1]);
		expect(setMemoryReferenceEnabled).toHaveBeenLastCalledWith(true);
		expect(setKnowledgeBaseEnabled).toHaveBeenLastCalledWith(false);
		expect(setWebVerbsEnabled).toHaveBeenLastCalledWith(true);
	});

	it("returns the newest limited messages and validates pagination parameters", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-pagination-test-"));
		roots.push(root);
		const firstPrompt = deferred();
		const permissions = new PermissionController("default");
		runtimeFactory.mockResolvedValue({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages: [],
				sessionId: "pagination-session",
				sessionFile: undefined,
				sessionName: undefined,
				setSessionName: vi.fn(),
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
				abort: async () => undefined,
			},
			extensionsResult: {} as never,
			subscribe: () => () => undefined,
			prompt: () => firstPrompt.promise,
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		} as never);
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0 });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };
		for (const prompt of ["one", "two", "three", "four"]) {
			await fetch(`${base}/session/${created.sessionId}/prompt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ prompt }),
			});
		}
		const limited = (await fetch(`${base}/session/${created.sessionId}/messages?after=0&limit=2`).then((response) =>
			response.json(),
		)) as { messages: Array<{ id: number; content: string }> };
		expect(limited.messages.map((message) => [message.id, message.content])).toEqual([
			[3, "three"],
			[4, "four"],
		]);
		const unlimited = (await fetch(`${base}/session/${created.sessionId}/messages?limit=0`).then((response) =>
			response.json(),
		)) as { messages: unknown[] };
		expect(unlimited.messages).toHaveLength(4);
		expect((await fetch(`${base}/session/${created.sessionId}/messages?after=bad`)).status).toBe(400);
		await fetch(`${base}/session/${created.sessionId}/cancel`, { method: "POST" });
		firstPrompt.resolve();
	});

	it("updates one local transcript record across streaming message replacements", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-streaming-dedupe-test-"));
		roots.push(root);
		const permissions = new PermissionController("default");
		const messages: Array<Record<string, unknown>> = [];
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const notify = (event: AgentSessionEvent): void => {
			for (const listener of listeners) listener(event);
		};
		const prompt = vi.fn(async () => {
			const user = { role: "user", content: "stream this", timestamp: 1 };
			messages.push(user);
			notify({ type: "message_start", message: user } as unknown as AgentSessionEvent);

			const initial = { role: "assistant", content: [], timestamp: 2, stopReason: "pending" };
			// Exercise runtimes that emit message_start before publishing the new
			// transcript slot; the bridge must reconcile the partial ID on the next sync.
			notify({ type: "message_start", message: initial } as unknown as AgentSessionEvent);
			messages.push(initial);
			for (const text of ["first", "first second", "first second final"]) {
				const update = {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: `plan: ${text}` },
						{ type: "text", text },
					],
					timestamp: 2,
					stopReason: "pending",
				};
				messages[1] = update;
				notify({
					type: "message_update",
					message: update,
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: text,
						partial: update,
					},
				} as unknown as AgentSessionEvent);
			}
			const sensitiveThinking = `plan complete api_key=trace-thinking-key Authorization: Bearer trace-thinking-bearer ${"x".repeat(30_000)}`;
			const final = {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: sensitiveThinking },
					{ type: "text", text: "first second final" },
				],
				timestamp: 2,
				stopReason: "stop",
			};
			messages[1] = final;
			notify({ type: "message_end", message: final } as unknown as AgentSessionEvent);
		});
		runtimeFactory.mockResolvedValue({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages,
				sessionId: "streaming-dedupe-session",
				sessionFile: undefined,
				sessionName: undefined,
				setSessionName: vi.fn(),
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
				abort: async () => undefined,
			},
			extensionsResult: {} as never,
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			prompt,
			setPermissionMode: () => undefined,
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		} as never);

		const bridge = new SecHeurBridge({ projectRoot: root, port: 0, schedulerBackend: false });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };

		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "stream this" }),
		});
		const result = (await fetch(`${base}/session/${created.sessionId}/messages`).then((response) =>
			response.json(),
		)) as { status: string; messages: Array<Record<string, unknown>> };

		expect(prompt).toHaveBeenCalledOnce();
		expect(result.status).toBe("idle");
		expect(result.messages).toHaveLength(2);
		expect(result.messages).toEqual([
			expect.objectContaining({ id: 1, role: "user", content: "stream this" }),
			expect.objectContaining({ id: 2, role: "assistant", content: "first second final", stopReason: "stop" }),
		]);
		const assistant = result.messages[1];
		expect(assistant?.thinking).toEqual(expect.stringContaining("plan complete"));
		expect(assistant?.thinking).toEqual(expect.stringContaining("[truncated]"));
		expect(assistant?.thinking).not.toContain("trace-thinking-key");
		expect(assistant?.thinking).not.toContain("trace-thinking-bearer");

		const log = (await fetch(`${base}/session/${created.sessionId}/runtime/log`).then((response) =>
			response.json(),
		)) as { events: Array<Record<string, unknown>> };
		const assistantEnd = log.events.find((event) => event.event === "message_end" && event.role === "assistant");
		expect(assistantEnd).toMatchObject({
			thinkingText: expect.stringContaining("plan complete"),
		});
		expect(assistantEnd?.thinkingText).toEqual(expect.stringContaining("[truncated]"));
		expect(JSON.stringify(log)).not.toContain("trace-thinking-key");
		expect(JSON.stringify(log)).not.toContain("trace-thinking-bearer");
	});

	it("serves runtime log snapshots and cursor-based deltas", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-runtime-log-delta-test-"));
		roots.push(root);
		const permissions = new PermissionController("default");
		const messages: Array<Record<string, unknown>> = [];
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		runtimeFactory.mockResolvedValue({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages,
				sessionId: "runtime-log-delta-session",
				sessionFile: undefined,
				sessionName: undefined,
				setSessionName: vi.fn(),
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
				abort: async () => undefined,
			},
			extensionsResult: {} as never,
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			prompt: async () => undefined,
			setPermissionMode: () => undefined,
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		} as never);
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0, schedulerBackend: false });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };

		const initial = (await fetch(`${base}/session/${created.sessionId}/runtime/log`).then((response) =>
			response.json(),
		)) as Record<string, unknown>;
		expect(initial).toMatchObject({
			incremental: false,
			resetRequired: false,
			messageCursor: 0,
			eventCursor: 1,
			messagesIncluded: true,
		});
		const epoch = String(initial.logEpoch);

		const user = { role: "user", content: "delta message", timestamp: 1_700_000_001 };
		messages.push(user);
		for (const listener of listeners) listener({ type: "message_start", message: user } as AgentSessionEvent);
		for (const listener of listeners) listener({ type: "message_end", message: user } as AgentSessionEvent);
		const delta = (await fetch(
			`${base}/session/${created.sessionId}/runtime/log?afterEventId=1&afterMessageId=0&logEpoch=${encodeURIComponent(epoch)}`,
		).then((response) => response.json())) as Record<string, unknown>;
		expect(delta).toMatchObject({
			incremental: true,
			resetRequired: false,
			messages: [expect.objectContaining({ id: 1, content: "delta message" })],
			messageCursor: 1,
		});

		const lightweight = (await fetch(
			`${base}/session/${created.sessionId}/runtime/log?afterEventId=1&afterMessageId=1&logEpoch=${encodeURIComponent(epoch)}&includeMessages=false`,
		).then((response) => response.json())) as Record<string, unknown>;
		expect(lightweight).toMatchObject({
			incremental: true,
			resetRequired: false,
			messages: [],
			messagesIncluded: false,
		});

		const reset = (await fetch(
			`${base}/session/${created.sessionId}/runtime/log?afterEventId=1&afterMessageId=1&logEpoch=stale`,
		).then((response) => response.json())) as Record<string, unknown>;
		expect(reset).toMatchObject({ incremental: true, resetRequired: true, messagesIncluded: true });
	});

	it("uses one stable assistant record while a local runtime is streaming", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-streaming-runtime-log-test-"));
		roots.push(root);
		const permissions = new PermissionController("default");
		const messages: Array<Record<string, unknown>> = [];
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const notify = (event: AgentSessionEvent): void => {
			for (const listener of listeners) listener(event);
		};
		const started = deferred();
		const release = deferred();
		const finished = deferred();
		const prompt = vi.fn(async () => {
			const user = { role: "user", content: "stream in place", timestamp: 1 };
			messages.push(user);
			notify({ type: "message_start", message: user } as unknown as AgentSessionEvent);
			notify({ type: "message_end", message: user } as unknown as AgentSessionEvent);

			const initial = { role: "assistant", content: [], timestamp: 2, stopReason: "pending" };
			// Exercise runtimes that publish the transcript slot after message_start.
			notify({ type: "message_start", message: initial } as unknown as AgentSessionEvent);
			messages.push(initial);
			started.resolve();
			await release.promise;

			const final = {
				role: "assistant",
				content: [{ type: "text", text: "stream complete" }],
				timestamp: 2,
				stopReason: "stop",
			};
			messages[1] = final;
			notify({ type: "message_end", message: final } as unknown as AgentSessionEvent);
			finished.resolve();
		});
		runtimeFactory.mockResolvedValue({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages,
				sessionId: "streaming-runtime-log-session",
				sessionFile: undefined,
				sessionName: undefined,
				setSessionName: vi.fn(),
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
				abort: async () => undefined,
			},
			extensionsResult: {} as never,
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			prompt,
			setPermissionMode: () => undefined,
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		} as never);

		const bridge = new SecHeurBridge({ projectRoot: root, port: 0, schedulerBackend: false });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };

		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "stream in place" }),
		});
		await started.promise;

		const readLog = async () =>
			(await fetch(`${base}/session/${created.sessionId}/runtime/log`).then((response) => response.json())) as {
				messages: Array<Record<string, unknown>>;
				partial: Record<string, unknown> | null;
			};
		const duringStart = await readLog();
		const startAssistants = duringStart.messages.filter((message) => message.role === "assistant");
		expect(startAssistants).toHaveLength(1);
		expect(duringStart.partial?.id).toBe(startAssistants[0]?.id);

		const update = {
			role: "assistant",
			content: [{ type: "text", text: "stream working" }],
			timestamp: 2,
			stopReason: "pending",
		};
		messages[1] = update;
		notify({ type: "message_update", message: update } as unknown as AgentSessionEvent);
		const duringUpdate = await readLog();
		const updateAssistants = duringUpdate.messages.filter((message) => message.role === "assistant");
		expect(updateAssistants).toHaveLength(1);
		expect(updateAssistants[0]?.content).toBe("stream working");
		expect(duringUpdate.partial?.id).toBe(updateAssistants[0]?.id);

		release.resolve();
		await finished.promise;
		const completed = await readLog();
		expect(completed.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
		expect(completed.partial).toBeNull();
	});

	it("keeps thinking content in managed snapshots and streaming partials", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-managed-thinking-test-"));
		roots.push(root);
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			managedSessions: true,
			worklist: false,
			competition: false,
		});
		bridges.push(bridge);

		type ManagedTestSession = {
			id: string;
			managed?: { registration: PiSessionRegistration; snapshot?: SessionSnapshot };
			messageRecords: Array<Record<string, unknown>>;
			partial: Record<string, unknown> | null;
		};
		const internals = bridge as unknown as {
			managedSessionPlaceholder: (registration: PiSessionRegistration) => ManagedTestSession;
			updateManagedSnapshot: (
				session: ManagedTestSession,
				snapshot: SessionSnapshot,
				includeMessages?: boolean,
			) => void;
		};
		const registration = {
			sessionId: "managed-thinking-session",
			role: "solver",
			title: "Thinking solver",
			socketPath: join(root, "solver.sock"),
			pid: process.pid,
			cwd: root,
			createdAt: 1_000,
			updatedAt: 2_000,
			status: "idle",
		} satisfies PiSessionRegistration;
		const user = {
			id: "user-1",
			role: "user",
			content: [{ type: "text", text: "solve this" }],
			timestamp: 1,
		} satisfies SessionSnapshot["transcript"][number];
		const completeAssistant = {
			id: "assistant-1",
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "inspect the target", redacted: true },
				{
					type: "toolCall",
					toolCallId: "call-1",
					toolName: "shell",
					input: { command: "id", api_key: "managed-secret" },
				},
				{ type: "text", text: "done" },
			],
			model: { provider: "faux", id: "model" },
			status: "complete",
			stopReason: "stop",
			timestamp: 2,
		} satisfies SessionSnapshot["transcript"][number];
		const toolResult = {
			id: "tool-1",
			role: "tool",
			toolCallId: "call-1",
			toolName: "shell",
			input: { command: "id", api_key: "managed-secret" },
			content: [{ type: "text", text: "uid=1000(user)" }],
			status: "complete",
			isError: false,
			timestamp: 3,
		} satisfies SessionSnapshot["transcript"][number];
		const completeSnapshot = {
			id: registration.sessionId,
			name: registration.title,
			cwd: root,
			createdAt: 1,
			updatedAt: 2,
			phase: "idle",
			model: { provider: "faux", id: "model" },
			thinkingLevel: "high",
			attached: true,
			locked: false,
			revision: 3,
			transcript: [user, completeAssistant, toolResult],
			queuedSteer: [],
			queuedSteerCount: 0,
		} satisfies SessionSnapshot;

		const session = internals.managedSessionPlaceholder(registration);
		session.managed = { registration };
		internals.updateManagedSnapshot(session, completeSnapshot, true);
		expect(session.messageRecords).toEqual([
			expect.objectContaining({ id: 1, role: "user", content: "solve this" }),
			expect.objectContaining({
				id: 2,
				role: "assistant",
				content: "done",
				thinking: "inspect the target",
				thinkingRedacted: true,
				toolCalls: [
					expect.objectContaining({
						id: "call-1",
						name: "shell",
						argsText: expect.stringContaining("[REDACTED]"),
					}),
				],
			}),
			expect.objectContaining({
				id: 3,
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "shell",
				content: "uid=1000(user)",
			}),
		]);

		const streamingAssistant = {
			...completeAssistant,
			status: "streaming",
			stopReason: undefined,
			content: [
				{ type: "thinking", thinking: "inspect the target further" },
				{ type: "text", text: "working" },
			],
		} as unknown as SessionSnapshot["transcript"][number];
		const streamingSnapshot = {
			...completeSnapshot,
			phase: "turn",
			revision: 3,
			updatedAt: 3,
			transcript: [user, streamingAssistant],
		} as SessionSnapshot;
		internals.updateManagedSnapshot(session, streamingSnapshot, true);
		expect(session.partial).toMatchObject({
			role: "assistant",
			content: "working",
			thinking: "inspect the target further",
			partial: true,
		});
	});

	it("opens only existing paths inside the project root", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-open-test-"));
		const outside = mkdtempSync(join(tmpdir(), "secheur-bridge-open-outside-"));
		roots.push(root, outside);
		const target = join(root, "notes.txt");
		const outsideTarget = join(outside, "secret.txt");
		writeFileSync(target, "notes");
		writeFileSync(outsideTarget, "secret");
		symlinkSync(outsideTarget, join(root, "outside-link"));
		const openPath = vi.fn();
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0, openPath });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;

		const opened = await fetch(`${base}/path/open`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "notes.txt" }),
		}).then((response) => response.json());
		expect(opened).toEqual({ ok: true, path: expect.stringMatching(/notes\.txt$/u) });
		expect(openPath).toHaveBeenCalledWith(expect.stringMatching(/notes\.txt$/u));
		expect(
			(
				await fetch(`${base}/path/open`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path: outsideTarget }),
				})
			).status,
		).toBe(400);
		expect(
			(
				await fetch(`${base}/path/open`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path: "outside-link" }),
				})
			).status,
		).toBe(400);
		expect(
			(
				await fetch(`${base}/path/open`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ kind: "unknown" }),
				})
			).status,
		).toBe(400);
	});

	it("proxies Flag Oracle dashboard routes without exposing the token", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-oracle-test-"));
		roots.push(root);
		const requests: Array<{ authorization: string; url: string }> = [];
		const oracle = createServer((request, response) => {
			requests.push({ authorization: request.headers.authorization ?? "", url: request.url ?? "" });
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify(
					request.url?.startsWith("/api/v1/summary")
						? { ok: true, challenges: [{ id: "challenge-1" }] }
						: { ok: true, attempts: [{ challengeId: "challenge-1" }] },
				),
			);
		});
		await new Promise<void>((resolveListen, reject) => {
			oracle.once("error", reject);
			oracle.listen(0, "127.0.0.1", resolveListen);
		});
		try {
			const address = oracle.address();
			if (!address || typeof address === "string") throw new Error("Oracle fixture has no TCP address");
			const bridge = new SecHeurBridge({
				projectRoot: root,
				port: 0,
				env: {
					...process.env,
					CTF_ORACLE_URL: `http://127.0.0.1:${address.port}`,
					CTF_ORACLE_TOKEN: "fixture-token",
					CTF_ORACLE_CLIENT_ENV_FILE: join(root, "missing.env"),
				},
			});
			bridges.push(bridge);
			await bridge.listen();
			const base = `http://127.0.0.1:${bridge.address.port}`;
			expect(await fetch(`${base}/api/ctf-oracle/summary?limit=2`).then((response) => response.json())).toEqual({
				ok: true,
				challenges: [{ id: "challenge-1" }],
			});
			expect(
				await fetch(`${base}/api/ctf-oracle/attempts?challenge_id=challenge-1&limit=3`).then((response) =>
					response.json(),
				),
			).toEqual({ ok: true, attempts: [{ challengeId: "challenge-1" }] });
			expect(requests.map((request) => request.url)).toEqual([
				"/api/v1/summary?limit=2",
				"/api/v1/attempts?limit=3&challengeId=challenge-1",
			]);
			expect(requests.every((request) => request.authorization === "Bearer fixture-token")).toBe(true);
		} finally {
			await new Promise<void>((resolveClose) => oracle.close(() => resolveClose()));
		}
	});

	it("discovers, closes, and restores persisted Pi sessions", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-persisted-test-"));
		roots.push(root);
		const persisted = createPersistedSession(root);
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0 });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;

		const listed = (await fetch(`${base}/sessions`).then((response) => response.json())) as {
			sessions: Array<{ id: string; title: string; sessionFile: string }>;
		};
		expect(listed.sessions).toEqual([
			expect.objectContaining({ id: persisted.id, title: "Persisted session", sessionFile: persisted.path }),
		]);

		const messages = (await fetch(`${base}/session/${persisted.id}/messages`).then((response) =>
			response.json(),
		)) as Record<string, unknown>;
		expect(messages).toMatchObject({
			sessionId: persisted.id,
			status: "idle",
			messages: [
				{ id: 1, role: "user", content: "hello" },
				{ id: 2, role: "assistant", content: "hello from pi" },
			],
			partial: null,
			msgSeq: 2,
			lastError: "",
		});
		expect(messages.updatedAt).toEqual(expect.any(Number));

		const closed = await fetch(`${base}/session/${persisted.id}`, { method: "DELETE" }).then((response) =>
			response.json(),
		);
		expect(closed).toMatchObject({ ok: true, status: "closed", persistent: true });
		const afterClose = (await fetch(`${base}/sessions`).then((response) => response.json())) as {
			sessions: unknown[];
		};
		expect(afterClose.sessions).toEqual([]);
		const continuable = (await fetch(`${base}/sessions/continuable`).then((response) => response.json())) as {
			sessions: Array<{ id: string }>;
		};
		expect(continuable.sessions).toEqual([expect.objectContaining({ id: persisted.id })]);

		const restored = await fetch(`${base}/session/${persisted.id}/restore`, { method: "POST" }).then((response) =>
			response.json(),
		);
		expect(restored).toMatchObject({ ok: true, sessionId: persisted.id, session: { status: "idle" } });
		const afterRestore = (await fetch(`${base}/sessions`).then((response) => response.json())) as {
			sessions: Array<{ id: string }>;
		};
		expect(afterRestore.sessions).toEqual([expect.objectContaining({ id: persisted.id })]);
	});

	it("forwards free-text ask_user answers through the permission broker", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-permission-test-"));
		roots.push(root);
		const broker = new PermissionBroker();
		const permissions = new PermissionController("default", broker);
		const fakeSession = {
			messages: [],
			sessionId: "permission-session",
			sessionFile: undefined,
			sessionName: undefined,
			setSessionName: vi.fn(),
			modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
			abort: async () => undefined,
		};
		runtimeFactory.mockResolvedValue({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: fakeSession,
			extensionsResult: {} as never,
			subscribe: () => () => undefined,
			prompt: async () => undefined,
			setPermissionMode: () => undefined,
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		} as never);
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0 });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };

		const answerPromise = broker.requestAnswer("ask_user", { candidates: [] }, "Which target?");
		const poll = (await fetch(`${base}/session/${created.sessionId}/messages`).then((response) =>
			response.json(),
		)) as { messages: Array<{ requestId?: string; role: string; status?: string }> };
		const permission = poll.messages.find((message) => message.role === "permission");
		expect(permission).toMatchObject({ role: "permission", status: "pending" });

		const resolved = await fetch(
			`${base}/session/${created.sessionId}/permission/${encodeURIComponent(permission!.requestId!)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ decision: "answer", answer: "target-42" }),
			},
		).then((response) => response.json());
		expect(resolved).toMatchObject({
			ok: true,
			message: { status: "resolved", decision: "answer", answer: "target-42" },
		});
		await expect(answerPromise).resolves.toBe("target-42");
	});

	it("remembers allow_session permission decisions", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-session-permission-test-"));
		roots.push(root);
		const permissions = new PermissionController("default");
		const fakeSession = {
			messages: [],
			sessionId: "session-permission",
			sessionFile: undefined,
			sessionName: undefined,
			setSessionName: vi.fn(),
			modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
			abort: async () => undefined,
		};
		runtimeFactory.mockResolvedValue({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: fakeSession,
			extensionsResult: {} as never,
			subscribe: () => () => undefined,
			prompt: async () => undefined,
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		} as never);
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0 });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };
		const input = { command: "rm -rf ./output", metadata: { attempt: 1, reason: "cleanup" } };
		const permissionPromise = permissions.broker.request("bash", input, "Dangerous command");
		const request = permissions.broker.list()[0];

		const resolved = await fetch(
			`${base}/session/${created.sessionId}/permission/${encodeURIComponent(request.id)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ decision: "allow_session" }),
			},
		).then((response) => response.json());

		expect(resolved).toMatchObject({ ok: true, decision: "allow_session" });
		await expect(permissionPromise).resolves.toBe(true);
		expect(
			permissions.evaluate("bash", {
				metadata: { reason: "cleanup", attempt: 1 },
				command: "rm -rf ./output",
			}).action,
		).toBe("allow");

		const invalidAnswerPromise = permissions.broker.request(
			"bash",
			{ command: "rm -rf ./other-output" },
			"Another dangerous command",
		);
		const invalidRequest = permissions.broker.list()[0];
		const invalidAnswerResponse = await fetch(
			`${base}/session/${created.sessionId}/permission/${encodeURIComponent(invalidRequest.id)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ decision: "answer", answer: "yes" }),
			},
		);
		if (permissions.broker.list().some((request) => request.id === invalidRequest.id)) {
			permissions.broker.resolve(invalidRequest.id, false);
		}
		expect(invalidAnswerResponse.status).toBe(400);
		await expect(invalidAnswerPromise).resolves.toBe(false);
	});

	it("waits for an interrupted prompt before starting a forced prompt", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-force-test-"));
		roots.push(root);
		const firstPrompt = deferred();
		const prompt = vi
			.fn()
			.mockImplementationOnce(() => firstPrompt.promise)
			.mockResolvedValue(undefined);
		const abort = vi.fn(async () => undefined);
		const permissions = new PermissionController("default");
		runtimeFactory.mockResolvedValue({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages: [],
				sessionId: "force-session",
				sessionFile: undefined,
				sessionName: undefined,
				setSessionName: vi.fn(),
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
				abort,
			},
			extensionsResult: {} as never,
			subscribe: () => () => undefined,
			prompt,
			abort,
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		} as never);
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0 });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };

		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "first" }),
		});
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "replacement", force: true }),
		});

		expect(abort).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledTimes(1);
		firstPrompt.resolve();
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
		expect(prompt.mock.calls.map(([value]) => value)).toEqual(["first", "replacement"]);
	});

	it("runs a prompt submitted while an active model switch is settling", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-model-transition-test-"));
		roots.push(root);
		const firstPrompt = deferred();
		const abortGate = deferred();
		const operations: string[] = [];
		const models = [
			{ provider: "fixture", id: "model-0" },
			{ provider: "fixture", id: "model-1" },
		];
		let selectedModel = models[0];
		const prompt = vi
			.fn()
			.mockImplementationOnce((value: string) => {
				operations.push(`prompt:${value}`);
				return firstPrompt.promise;
			})
			.mockImplementation(async (value: string) => {
				operations.push(`prompt:${value}`);
			});
		const abort = vi.fn(() => abortGate.promise);
		const setModel = vi.fn(async (model: (typeof models)[number]) => {
			selectedModel = model;
			operations.push(`model:${model.id}`);
		});
		const permissions = new PermissionController("default");
		runtimeFactory.mockResolvedValue({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages: [],
				sessionId: "model-transition-session",
				sessionFile: undefined,
				sessionName: undefined,
				get model() {
					return selectedModel;
				},
				setSessionName: vi.fn(),
				modelRuntime: {
					getAvailableSnapshot: () => models,
					getModels: () => models,
					getModel: (provider: string, id: string) =>
						models.find((model) => model.provider === provider && model.id === id),
				},
				setModel,
				abort,
			},
			extensionsResult: {} as never,
			subscribe: () => () => undefined,
			prompt,
			abort,
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		} as never);
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0 });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };

		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "first" }),
		});
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
		const modelRequest = fetch(`${base}/session/${created.sessionId}/model`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ llmNo: 1 }),
		}).then((response) => response.json());
		await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));

		const submitted = await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "after switch" }),
		}).then((response) => response.json());
		expect(submitted).toMatchObject({ ok: true, accepted: true, queued: false });
		expect(prompt).toHaveBeenCalledTimes(1);

		abortGate.resolve();
		firstPrompt.resolve();
		await expect(modelRequest).resolves.toMatchObject({ ok: true, llmNo: 1, wasRunning: true });
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
		expect(operations).toEqual(["prompt:first", "model:model-1", "prompt:after switch"]);
		await vi.waitFor(async () => {
			const state = (await fetch(`${base}/session/${created.sessionId}/messages`).then((response) =>
				response.json(),
			)) as { status: string };
			expect(state.status).toBe("idle");
		});
	});

	it("keeps an explicitly cancelled session cancelled after the old prompt settles", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-cancel-test-"));
		roots.push(root);
		const firstPrompt = deferred();
		const permissions = new PermissionController("default");
		runtimeFactory.mockResolvedValue({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages: [],
				sessionId: "cancel-session",
				sessionFile: undefined,
				sessionName: undefined,
				setSessionName: vi.fn(),
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
				abort: async () => undefined,
			},
			extensionsResult: {} as never,
			subscribe: () => () => undefined,
			prompt: () => firstPrompt.promise,
			abort: async () => undefined,
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		} as never);
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0 });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };
		const paused = await fetch(`${base}/session/${created.sessionId}/pause`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: "test", reason: "operator pause" }),
		}).then((response) => response.json());
		expect(paused).toMatchObject({ paused: true, status: "paused", prePauseStatus: "idle" });
		const pausedSnapshot = await fetch(`${base}/session/${created.sessionId}`).then((response) => response.json());
		expect(pausedSnapshot).toMatchObject({
			session: { pauseSource: "test", pauseReason: "operator pause", prePauseStatus: "idle" },
		});
		const resumed = await fetch(`${base}/session/${created.sessionId}/resume`, { method: "POST" }).then((response) =>
			response.json(),
		);
		expect(resumed).toMatchObject({ resumed: true, status: "idle" });
		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "long task" }),
		});
		const cancelled = await fetch(`${base}/session/${created.sessionId}/cancel`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: "test", reason: "operator stop" }),
		}).then((response) => response.json());
		expect(cancelled).toMatchObject({ cancelled: true, status: "cancelled", preCancelStatus: "running" });

		firstPrompt.resolve();
		await vi.waitFor(async () => {
			const snapshot = (await fetch(`${base}/session/${created.sessionId}`).then((response) => response.json())) as {
				session: { status: string; cancelSource: string; cancelReason: string; preCancelStatus: string };
			};
			expect(snapshot.session).toMatchObject({
				status: "cancelled",
				cancelSource: "test",
				cancelReason: "operator stop",
				preCancelStatus: "running",
			});
		});
	});

	it("reports an assistant provider error as a session error", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-provider-error-test-"));
		roots.push(root);
		const permissions = new PermissionController("default");
		const messages: Array<Record<string, unknown>> = [];
		runtimeFactory.mockResolvedValue({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages,
				sessionId: "provider-error-session",
				sessionFile: undefined,
				sessionName: undefined,
				setSessionName: vi.fn(),
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
				abort: async () => undefined,
			},
			extensionsResult: {} as never,
			subscribe: () => () => undefined,
			prompt: async () => {
				messages.push({
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "Provider connection failed",
					timestamp: Date.now(),
				});
			},
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		} as never);
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0 });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };
		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "trigger provider error" }),
		});

		await vi.waitFor(async () => {
			const state = (await fetch(`${base}/session/${created.sessionId}/messages`).then((response) =>
				response.json(),
			)) as { status: string; lastError: string };
			expect(state).toMatchObject({ status: "error", lastError: "Provider connection failed" });
		});
	});

	it.each([
		{ status: "transport_error", failureCategory: "transport_error", failureCode: "verifier_transport_error" },
		{ status: "limit_exceeded", failureCategory: "quota_exhausted", failureCode: "verifier_quota_exhausted" },
	])(
		"reports verifier transport trouble without stopping, and marks quota exhaustion",
		async ({ status, failureCategory, failureCode }) => {
			const root = mkdtempSync(join(tmpdir(), "secheur-bridge-verifier-error-test-"));
			roots.push(root);
			const permissions = new PermissionController("default");
			const listeners = new Set<(event: AgentSessionEvent) => void>();
			let promptCount = 0;
			runtimeFactory.mockImplementation(async (options: CreateSecHeurRuntimeOptions) => ({
				config: {} as never,
				getBudgetStatus: () => ({ stopped: false }),
				state: {
					permissions,
					permissionBroker: permissions.broker,
					getTurnCount: () => 0,
					getLastJudge: () => undefined,
					close: () => undefined,
				},
				session: {
					messages: [],
					sessionId: "verifier-error-session",
					sessionFile: undefined,
					sessionName: undefined,
					setSessionName: vi.fn(),
					modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
					abort: async () => undefined,
				},
				extensionsResult: {} as never,
				subscribe: (listener: (event: AgentSessionEvent) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				prompt: async () => {
					promptCount += 1;
					if (failureCategory === "quota_exhausted" && options.ctfContinuation)
						options.ctfContinuation.verificationAttemptsRemaining = 0;
					for (const listener of listeners) {
						listener({
							type: "tool_execution_end",
							toolCallId: "verify-call-1",
							toolName: "verify_flag",
							result: {
								details: {
									data: {
										ok: false,
										status,
										verified: false,
										verificationOutcome: "infra_error",
										failureCategory,
										message: "socket refused",
									},
								},
							},
							isError: true,
						});
					}
				},
				setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
				setMemoryReferenceEnabled: () => undefined,
				setKnowledgeBaseEnabled: () => undefined,
				setWebVerbsEnabled: () => undefined,
				dispose: () => undefined,
			}));
			const bridge = new SecHeurBridge({
				projectRoot: root,
				port: 0,
				schedulerBackend: false,
				worklist: false,
				competition: false,
			});
			bridges.push(bridge);
			await bridge.listen();
			const base = `http://127.0.0.1:${bridge.address.port}`;
			const created = (await fetch(`${base}/session/new`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ cwd: root, persist: false, taskKind: "ctf" }),
			}).then((response) => response.json())) as { sessionId: string };
			await fetch(`${base}/session/${created.sessionId}/prompt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ prompt: "verify candidate" }),
			});
			await vi.waitFor(async () => {
				const snapshot = await fetch(`${base}/session/${created.sessionId}`).then((response) => response.json());
				expect(snapshot).toMatchObject({
					session: {
						status: "idle",
						terminalReason:
							failureCategory === "quota_exhausted" ? "verification_budget_exhausted" : "unverified_idle",
						verificationState: "not_attempted",
						failureSource: "verifier",
						failureStage: "verification",
						failureCode,
					},
				});
			});
			expect(promptCount).toBe(1);
		},
	);

	it("accepts a native verifier result through the existing CTF gate", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-verifier-success-test-"));
		roots.push(root);
		const permissions = new PermissionController("default");
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		runtimeFactory.mockImplementation(async () => ({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 1,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages: [],
				sessionId: "verifier-success-session",
				sessionFile: undefined,
				sessionName: undefined,
				setSessionName: vi.fn(),
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
				abort: async () => undefined,
			},
			extensionsResult: {} as never,
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			prompt: async () => {
				for (const listener of listeners) {
					listener({
						type: "tool_execution_end",
						toolCallId: "verify-call-1",
						toolName: "verify_flag",
						result: {
							details: {
								data: {
									ok: true,
									status: "correct",
									verified: true,
									correct: true,
									verificationOutcome: "correct",
								},
							},
						},
						isError: false,
					});
				}
			},
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		}));
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			worklist: false,
			competition: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false, taskKind: "ctf" }),
		}).then((response) => response.json())) as { sessionId: string };
		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "verify candidate" }),
		});
		await vi.waitFor(async () => {
			const snapshot = await fetch(`${base}/session/${created.sessionId}`).then((response) => response.json());
			expect(snapshot).toMatchObject({
				session: {
					status: "idle",
					terminalReason: "verified_true",
					verificationState: "accepted",
				},
			});
		});
	});

	it.each([
		[true, false],
		[false, false],
		[true, true],
	])(
		"uses only host-owned competition acceptance for desktop completion: trusted=%s throw=%s",
		async (trusted, throwAfterVerdict) => {
			const root = mkdtempSync(join(tmpdir(), "secheur-bridge-verifier-success-test-"));
			roots.push(root);
			const permissions = new PermissionController("default");
			const listeners = new Set<(event: AgentSessionEvent) => void>();
			const binding: { verifiedSubmission?: { recordId: string; taskId: string; assignmentId: string } } = {};
			runtimeFactory.mockImplementation(async () => ({
				config: {} as never,
				getBudgetStatus: () => ({ stopped: false }),
				state: {
					competition: binding,
					permissions,
					permissionBroker: permissions.broker,
					getTurnCount: () => 1,
					getLastJudge: () => undefined,
					close: () => undefined,
				},
				session: {
					messages: [],
					sessionId: "verifier-success-session",
					sessionFile: undefined,
					sessionName: undefined,
					setSessionName: vi.fn(),
					modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
					abort: async () => undefined,
				},
				extensionsResult: {} as never,
				subscribe: (listener: (event: AgentSessionEvent) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				prompt: async () => {
					if (trusted)
						binding.verifiedSubmission = {
							recordId: "offline-record",
							taskId: "offline-task",
							assignmentId: "offline-assignment",
						};
					for (const listener of listeners) {
						listener({
							type: "tool_execution_end",
							toolCallId: "verify-call-1",
							toolName: "competition_submit_request",
							result: { details: { accepted: true, submission: { category: "accepted", isCorrect: true } } },
							isError: false,
						});
					}
					if (throwAfterVerdict) throw new Error("Trusted verification already completed this run");
				},
				setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
				setMemoryReferenceEnabled: () => undefined,
				setKnowledgeBaseEnabled: () => undefined,
				setWebVerbsEnabled: () => undefined,
				dispose: () => undefined,
			}));
			const bridge = new SecHeurBridge({
				projectRoot: root,
				port: 0,
				schedulerBackend: false,
				worklist: false,
				competition: false,
			});
			bridges.push(bridge);
			await bridge.listen();
			const base = `http://127.0.0.1:${bridge.address.port}`;
			const created = (await fetch(`${base}/session/new`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ cwd: root, persist: false, taskKind: "ctf" }),
			}).then((response) => response.json())) as { sessionId: string };
			await fetch(`${base}/session/${created.sessionId}/prompt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ prompt: "verify candidate" }),
			});
			await vi.waitFor(async () => {
				const snapshot = await fetch(`${base}/session/${created.sessionId}`).then((response) => response.json());
				expect(snapshot).toMatchObject({
					session: {
						status: "idle",
						terminalReason: trusted ? "verified_true" : "unverified_idle",
						verificationState: trusted ? "accepted" : "not_attempted",
					},
				});
			});
		},
	);

	it("manages a session through the compatibility routes", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-session-test-"));
		roots.push(root);
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const sessionManager = { kind: "in-memory-session-manager" };
		const fakeSession = {
			messages: [],
			sessionId: "session-1",
			sessionFile: undefined,
			sessionName: undefined,
			sessionManager,
			setSessionName: vi.fn(),
			modelRuntime: {
				getAvailableSnapshot: () => [{ provider: "fixture-provider", id: "fixture-model", name: "Fixture Model" }],
				getModels: () => [{ provider: "fixture-provider", id: "fixture-model", name: "Fixture Model" }],
				getModel: () => undefined,
			},
			abort: async () => undefined,
		};
		const permissions = new PermissionController("default");
		const dispose = vi.fn();
		runtimeFactory.mockResolvedValue({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: fakeSession,
			extensionsResult: {} as never,
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			prompt: async () => undefined,
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose,
		} as never);
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0 });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;

		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				cwd: root,
				title: "Smoke session",
				persist: false,
				taskKind: "ctf",
				interactionMode: "autonomous",
				maxTurns: 7,
			}),
		}).then((response) => response.json())) as { sessionId?: unknown; [key: string]: unknown };
		expect(created).toMatchObject({
			ok: true,
			session: {
				title: "Smoke session",
				cwd: root,
				status: "idle",
				taskKind: "ctf",
				interactionMode: "autonomous",
				terminalReason: null,
				verificationState: "not_attempted",
			},
		});
		const sessionId = String(created.sessionId);
		const modelProfiles = await fetch(`${base}/model-profiles`).then((response) => response.json());
		expect(modelProfiles).toEqual({
			profiles: [
				{
					id: 0,
					llmNo: 0,
					name: "fixture-provider/fixture-model",
					provider: "fixture-provider",
					model: "fixture-model",
					active: false,
				},
			],
		});

		const reset = await fetch(`${base}/session/${sessionId}/runtime/reset`, { method: "POST" }).then((response) =>
			response.json(),
		);
		expect(reset).toMatchObject({ ok: true, runtimeReset: true, sessionId });
		expect(dispose).toHaveBeenCalledTimes(1);
		await fetch(`${base}/session/${sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "after reset" }),
		});
		await vi.waitFor(() => expect(runtimeFactory).toHaveBeenCalledTimes(2));
		expect(runtimeFactory.mock.calls[1]?.[0]).toMatchObject({ persist: false });
		expect(runtimeFactory.mock.calls[1]?.[0]?.sessionManager).toBe(sessionManager);
		for (const listener of listeners) {
			listener({
				type: "tool_execution_start",
				toolCallId: "tool-call-1",
				toolName: "fixture_tool",
				args: {
					command: "echo ok",
					headers: { Authorization: "Bearer trace-secret" },
					api_key: "trace-api-key",
				},
			});
			listener({
				type: "tool_execution_update",
				toolCallId: "tool-call-1",
				toolName: "fixture_tool",
				args: { command: "echo ok" },
				partialResult: { content: "streaming" },
			});
			listener({
				type: "tool_execution_end",
				toolCallId: "tool-call-1",
				toolName: "fixture_tool",
				result: { content: '{"api_key":"trace-string-key"}', token: "trace-result-token" },
				isError: false,
			});
			listener({
				type: "tool_execution_end",
				toolCallId: "verify-call-1",
				toolName: "verify_flag",
				result: { details: { data: { ok: true, verified: true, status: "correct" } } },
				isError: false,
			});
		}
		const terminal = await fetch(`${base}/session/${sessionId}`).then((response) => response.json());
		expect(terminal).toMatchObject({
			session: { taskKind: "ctf", terminalReason: "verified_true", verificationState: "accepted" },
		});
		const log = (await fetch(`${base}/session/${sessionId}/runtime/log`).then((response) => response.json())) as {
			messages: Array<Record<string, unknown>>;
			partial: Record<string, unknown> | null;
			events: Array<Record<string, unknown>>;
		};
		expect(log).toMatchObject({
			ok: true,
			sessionId,
			messages: [expect.objectContaining({ role: "user", content: "after reset" })],
			partial: null,
			events: expect.arrayContaining([
				expect.objectContaining({
					event: "tool_execution_start",
					toolCallId: "tool-call-1",
					toolName: "fixture_tool",
					argsText: expect.stringContaining("[REDACTED]"),
				}),
				expect.objectContaining({
					event: "tool_execution_end",
					toolCallId: "tool-call-1",
					resultText: expect.stringContaining("[REDACTED]"),
					isError: false,
				}),
			]),
		});
		expect(log.events.some((event) => event.event === "tool_execution_update")).toBe(false);
		expect(JSON.stringify(log)).not.toContain("trace-secret");
		expect(JSON.stringify(log)).not.toContain("trace-api-key");
		expect(JSON.stringify(log)).not.toContain("trace-result-token");
		expect(JSON.stringify(log)).not.toContain("trace-string-key");
		const exported = await fetch(`${base}/session/${sessionId}/export`).then((response) => response.json());
		expect(exported).toMatchObject({
			ok: true,
			sessionId,
			messages: [expect.objectContaining({ role: "user", content: "after reset" })],
			runtimeLog: expect.any(Array),
		});
		const deletedSession = await fetch(`${base}/session/${sessionId}`, { method: "DELETE" }).then((response) =>
			response.json(),
		);
		expect(deletedSession).toMatchObject({ ok: true, status: "closed" });
		expect(listeners.size).toBe(0);
	});
});
