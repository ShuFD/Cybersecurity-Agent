import { randomUUID } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
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
import { BackgroundCommands } from "../src/background-commands.ts";
import { writeDesktopConfig } from "../src/desktop-config.ts";
import type { CtfContinuationState, TrustedTaskIdentity } from "../src/extension.ts";
import { createSecHeurRuntime } from "../src/runtime.ts";

const temporaryRoots: string[] = [];

async function listenMockVerifier(response: Record<string, unknown>): Promise<{
	path: string;
	requests: Array<Record<string, unknown>>;
	close: () => Promise<void>;
}> {
	const path =
		process.platform === "win32"
			? `\\\\.\\pipe\\secheur-runtime-verifier-${randomUUID()}`
			: join(tmpdir(), `secheur-runtime-verifier-${randomUUID()}.sock`);
	const requests: Array<Record<string, unknown>> = [];
	const server = createServer((socket: Socket) => {
		let buffer = "";
		socket.on("data", (chunk: Buffer | string) => {
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			requests.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
			socket.end(`${JSON.stringify(response)}\n`);
		});
	});
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(path, () => {
			server.removeListener("error", reject);
			resolvePromise();
		});
	});
	return {
		path,
		requests,
		close: () =>
			new Promise<void>((resolvePromise, reject) => {
				server.close((error) => (error ? reject(error) : resolvePromise()));
			}),
	};
}

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "secheur-runtime-e2e-"));
	temporaryRoots.push(root);
	return root;
}

function contextText(messages: readonly unknown[]): string {
	return JSON.stringify(messages);
}

async function createCtfFauxRuntime(
	root: string,
	oracleSocket?: string,
	trustedTaskIdentity?: TrustedTaskIdentity,
	executionMode = "direct",
	cwd?: string,
) {
	writeDesktopConfig(root, {
		judge: { enabled: false },
		planning: { mode: executionMode === "plan_single" ? "active" : "off" },
	});
	const faux = fauxProvider({ models: [{ id: "faux-ctf", reasoning: true }] });
	const piDir = join(root, ".secheur-agent", "pi");
	mkdirSync(piDir, { recursive: true });
	writeFileSync(
		join(piDir, "auth.json"),
		JSON.stringify({ [faux.provider.id]: { type: "api_key", key: "faux-key" } }),
	);
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	const ctfContinuation: CtfContinuationState = {
		taskKind: "ctf",
		verificationState: "not_attempted",
		consecutiveNoToolTurns: 0,
	};
	const runtime = await createSecHeurRuntime({
		projectRoot: root,
		cwd,
		legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
		persist: false,
		model: faux.getModel(),
		modelRuntime,
		ctfContinuation,
		executionMode,
		trustedTaskIdentity,
		requireTrustedChallengeId: executionMode === "plan_single",
		env: {
			PATH: process.env.PATH,
			PI_OFFLINE: "1",
			SECHEUR_PYTHON: resolve(import.meta.dirname, "../../../.secheur-agent/python/bin/python"),
			CTF_ORACLE_CLIENT_ENV_FILE: join(root, "missing-oracle-client.env"),
			...(oracleSocket ? { CTF_ORACLE_SOCKET: oracleSocket } : {}),
		},
	});
	runtime.setMemoryReferenceEnabled(false);
	runtime.config.maxTurns = 12;
	const setResponses = faux.setResponses.bind(faux);
	faux.setResponses = (responses) =>
		setResponses([
			...responses,
			...Array.from({ length: 16 }, () => fauxAssistantMessage("Synthetic continuation until parent budget.")),
		]);
	return { ctfContinuation, faux, runtime };
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SecHeur Pi runtime", () => {
	it("batches completed results before the next request during a continuous tool loop without skipping tools", async () => {
		const { faux, runtime } = await createCtfFauxRuntime(temporaryRoot());
		runtime.setPermissionMode("bypassPermissions");
		let inspected = false;
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("bash", { command: "sleep 0.05; printf completion-one", run_in_background: true }),
				fauxToolCall("bash", { command: "sleep 0.05; printf completion-two", run_in_background: true }),
			]),
			fauxAssistantMessage([
				fauxToolCall("bash", { command: "sleep 0.2; printf batch-witness-one" }),
				fauxToolCall("bash", { command: "printf batch-witness-two" }),
			]),
			(context) => {
				const text = contextText(context.messages);
				for (const marker of ["completion-one", "completion-two", "batch-witness-one", "batch-witness-two"])
					expect(text).toContain(marker);
				const completions = runtime.session.messages.filter(
					(message) => message.role === "custom" && message.customType === "secheur-command-completion",
				);
				expect(completions).toHaveLength(1);
				const completionText = contextText(completions);
				expect(completionText).toContain("completion-one");
				expect(completionText).toContain("completion-two");
				const toolResults = contextText(
					runtime.session.messages.filter((message) => message.role === "toolResult"),
				);
				expect(toolResults).toContain("batch-witness-one");
				expect(toolResults).toContain("batch-witness-two");
				expect(runtime.state.commandTasks?.undeliveredCount).toBe(0);
				inspected = true;
				return fauxAssistantMessage(fauxToolCall("bash", { command: "printf continued-tool-loop" }));
			},
			...Array.from({ length: 4 }, () => fauxAssistantMessage("Generic work complete.")),
		]);
		try {
			await runtime.prompt("Run generic background jobs and continue independent tool calls.");
			expect(inspected).toBe(true);
			expect(
				runtime.session.messages.filter(
					(message) => message.role === "custom" && message.customType === "secheur-command-completion",
				),
			).toHaveLength(1);
			const root = runtime.config.stateDir;
			const dirs = readdirSync(join(root, "command-tasks"));
			const records = dirs.flatMap((dir) =>
				readdirSync(join(root, "command-tasks", dir))
					.filter((file) => file.endsWith(".json"))
					.map((file) => JSON.parse(readFileSync(join(root, "command-tasks", dir, file), "utf8"))),
			);
			expect(records.filter((record) => record.delivered_at)).toHaveLength(2);
			for (const record of records.filter((record) => record.delivered_at)) {
				expect(record.delivered_at).toBeGreaterThanOrEqual(record.completed_at);
				expect(record.delivered_at - record.completed_at).toBeLessThan(2000);
			}
			if (process.env.SECHEUR_HARNESS_ACCEPTANCE_REPORT)
				writeFileSync(
					process.env.SECHEUR_HARNESS_ACCEPTANCE_REPORT,
					JSON.stringify(
						{
							backgroundJobs: 2,
							deliveredMessages: 1,
							batchToolsExecuted: 2,
							deliveryDelayMs: records
								.filter((record) => record.delivered_at)
								.map((record) => record.delivered_at - record.completed_at),
							pendingNotifications: runtime.state.commandTasks?.undeliveredCount,
						},
						null,
						2,
					),
				);
		} finally {
			runtime.dispose();
		}
	}, 15000);
	it("routes old controls to native tasks and reports unknown task IDs as tool errors", async () => {
		const { faux, runtime } = await createCtfFauxRuntime(temporaryRoot());
		runtime.setPermissionMode("bypassPermissions");
		let taskId = "";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 20", run_in_background: true })),
			() => {
				const result = runtime.session.messages.find(
					(message) => message.role === "toolResult" && message.toolName === "bash",
				);
				if (result?.role === "toolResult") taskId = (result.details as { task_id: string }).task_id;
				return fauxAssistantMessage(fauxToolCall("task_output", { task_id: taskId }));
			},
			() => fauxAssistantMessage(fauxToolCall("task_stop", { task_id: taskId })),
			fauxAssistantMessage(fauxToolCall("task_output", { task_id: "missing-session-task" })),
			fauxAssistantMessage(fauxToolCall("command_task_stop", { task_id: "missing-session-task" })),
			...Array.from({ length: 4 }, () => fauxAssistantMessage("Generic controls checked.")),
		]);
		try {
			await runtime.prompt("Exercise generic background task controls.");
			const results = runtime.session.messages.filter((message) => message.role === "toolResult");
			expect(results.find((message) => message.toolName === "task_stop")?.isError).toBe(false);
			expect(contextText(results.filter((message) => message.toolName === "task_stop"))).toContain("cancelled");
			expect(results.filter((message) => message.isError)).toHaveLength(2);
			expect(runtime.state.commandTasks?.pendingCount).toBe(0);
		} finally {
			runtime.dispose();
		}
	}, 15000);
	it("routes new controls to legacy tasks", async () => {
		const { faux, runtime } = await createCtfFauxRuntime(temporaryRoot());
		runtime.setPermissionMode("bypassPermissions");
		const launch = await runtime.state.legacyHost.call("code_run", {
			script: "import time; time.sleep(20)",
			run_in_background: true,
		});
		const id = (launch.data as { task_id: string }).task_id;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("command_task_output", { task_id: id })),
			fauxAssistantMessage(fauxToolCall("command_task_stop", { task_id: id })),
			...Array.from({ length: 4 }, () => fauxAssistantMessage("Generic controls checked.")),
		]);
		try {
			await runtime.prompt("Query and stop the existing generic task.");
			const results = runtime.session.messages.filter((message) => message.role === "toolResult");
			expect(results).toHaveLength(2);
			expect(results.every((message) => !message.isError)).toBe(true);
		} finally {
			await runtime.state.legacyHost.call("__command_task_stop", { task_id: id });
			runtime.dispose();
		}
	}, 15000);
	it("uses agent state storage for native and legacy commands in a read-only workspace", async () => {
		const root = temporaryRoot();
		const cwd = join(root, "readonly-workspace");
		mkdirSync(cwd);
		chmodSync(cwd, 0o555);
		const { faux, runtime } = await createCtfFauxRuntime(root, undefined, undefined, "direct", cwd);
		runtime.setPermissionMode("bypassPermissions");
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf native-readonly" })),
			fauxAssistantMessage(fauxToolCall("code_run", { script: "print('legacy-readonly')" })),
			...Array.from({ length: 5 }, () => fauxAssistantMessage("Generic commands completed.")),
		]);
		try {
			await runtime.prompt("Run generic commands from the read-only workspace.");
			const text = contextText(runtime.session.state.messages.filter((message) => message.role === "toolResult"));
			expect(text).toContain("native-readonly");
			expect(text).toContain("legacy-readonly");
			expect(text).not.toContain("EACCES");
			expect(runtime.state.commandTasks?.pendingCount).toBe(0);
			expect(readdirSync(cwd)).toEqual([]);
		} finally {
			runtime.dispose();
			chmodSync(cwd, 0o755);
		}
	}, 15000);
	it("cleans up a real legacy Python job without killing the shared IPC host", async () => {
		const root = temporaryRoot();
		const { faux, runtime } = await createCtfFauxRuntime(root);
		runtime.setPermissionMode("bypassPermissions");
		runtime.config.maxTurns = 1;
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("code_run", {
					script:
						"import time; from pathlib import Path; time.sleep(1.5); Path('cancel-witness.txt').write_text('orphan')",
					run_in_background: true,
				}),
			),
		]);
		try {
			await runtime.prompt("Start and cancel a generic Python command at the run budget.");
			expect(runtime.state.commandTasks?.pendingCount).toBe(0);
			const response = await runtime.state.legacyHost.call("code_run", { script: "print('host-still-responsive')" });
			expect(response.ok).toBe(true);
			expect(response.content).toContain("host-still-responsive");
			await new Promise((resolve) => setTimeout(resolve, 1600));
			expect(readdirSync(root)).not.toContain("cancel-witness.txt");
		} finally {
			runtime.dispose();
		}
	}, 15000);
	it("delivers a real legacy Python background result while keeping the IPC host usable", async () => {
		const { faux, runtime } = await createCtfFauxRuntime(temporaryRoot());
		runtime.setPermissionMode("bypassPermissions");
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("code_run", {
					script: "import time; time.sleep(0.4); print('legacy-completed')",
					run_in_background: true,
				}),
			),
			fauxAssistantMessage(fauxToolCall("code_run", { script: "print('legacy-independent')" })),
			...Array.from({ length: 5 }, () => fauxAssistantMessage("Waiting for command results.")),
		]);
		try {
			await runtime.prompt("Run generic background and independent Python commands.");
			const text = contextText(runtime.session.state.messages);
			expect(
				contextText(runtime.session.state.messages.filter((message) => message.role === "toolResult")),
			).toContain("legacy-independent");
			const completions = contextText(
				runtime.session.state.messages.filter(
					(message) => message.role === "custom" && message.customType === "secheur-command-completion",
				),
			);
			expect(completions).toContain("legacy-completed");
			expect(completions).toContain("completed.");
			expect(text).not.toContain("Legacy Python runtime is not ready");
			expect(runtime.state.commandTasks?.pendingCount).toBe(0);
		} finally {
			runtime.dispose();
		}
	}, 15000);

	it("keeps the turn budget across a background completion wakeup", async () => {
		const { faux, runtime } = await createCtfFauxRuntime(temporaryRoot());
		runtime.config.maxTurns = 3;
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bash", { command: "sleep 0.3; printf budget-result", run_in_background: true }),
			),
			fauxAssistantMessage("Waiting for the result."),
			fauxAssistantMessage("The command completed."),
		]);
		try {
			await runtime.prompt("Wait asynchronously and preserve the budget.");
			expect(runtime.getBudgetStatus()).toMatchObject({ stopped: true, turnsUsed: 3, reason: "maxTurns" });
			expect(contextText(runtime.session.state.messages)).toContain("budget-result");
		} finally {
			runtime.dispose();
		}
	}, 10000);

	it("cancels pending background work when the turn budget is reached", async () => {
		const { faux, runtime } = await createCtfFauxRuntime(temporaryRoot());
		runtime.config.maxTurns = 1;
		faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 20", run_in_background: true }))]);
		try {
			await runtime.prompt("Start a command within a one-turn budget.");
			expect(runtime.getBudgetStatus()).toMatchObject({ stopped: true, turnsUsed: 1 });
			expect(runtime.state.commandTasks?.pendingCount).toBe(0);
			expect(contextText(runtime.session.state.messages)).not.toContain("secheur-command-completion");
		} finally {
			runtime.dispose();
		}
	}, 10000);

	it("continues independent work and wakes the real DIRECT Pi session when a background command completes", async () => {
		const root = temporaryRoot();
		const { faux, runtime } = await createCtfFauxRuntime(root);
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bash", { command: "sleep 0.5; printf completed-background", timeout: 0.02 }),
			),
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf recovered" })),
			fauxAssistantMessage("No verified answer yet."),
			fauxAssistantMessage("No verified answer yet."),
			fauxAssistantMessage("No verified answer yet."),
			fauxAssistantMessage("No verified answer yet."),
		]);
		try {
			await runtime.prompt("Run the bounded command, inspect its result, and continue.");
			const text = contextText(runtime.session.state.messages);
			expect(text).toContain("Processing");
			expect(text).toContain("completed-background");
			expect(text).toContain("secheur-command-completion");
			expect(text).toContain("recovered");
			expect(
				runtime.session.state.messages.some((message) => message.role === "toolResult" && message.isError),
			).toBe(false);
			expect(runtime.session.getAllTools().find((tool) => tool.name === "bash")?.description).toContain(
				"maximum 600",
			);
		} finally {
			runtime.dispose();
		}
	}, 10000);

	it("passes the trusted target through a real PLAN_SINGLE executor child", async () => {
		const verifier = await listenMockVerifier({ ok: true, status: "correct", verified: true });
		const root = temporaryRoot();
		const { faux, runtime } = await createCtfFauxRuntime(
			root,
			verifier.path,
			{ challengeId: "cybench/plan-single-target", runId: "field-run-plan-single" },
			"plan_single",
		);
		const supervisorResponse = fauxAssistantMessage(
			JSON.stringify({
				decision: "create_tasks",
				rationale: "verify the candidate",
				tasks: [
					{
						key: "verify",
						objective: "verify the candidate",
						doneWhen: "the verification result is recorded",
						priority: 1,
						dependsOn: [],
					},
				],
				answerEvidenceRefs: [],
			}),
		);
		const executorVerifyResponse = fauxAssistantMessage(fauxToolCall("verify_flag", { flag: "MOCK_CANDIDATE" }));
		const executorCommitResponse = fauxAssistantMessage(
			fauxToolCall("planning_commit_result", {
				outcome: "done",
				summary: "The candidate was checked by the verifier.",
			}),
		);
		const presentationResponse = fauxAssistantMessage("The candidate was checked and accepted.");
		const responseForCall = (_context: unknown, _options: unknown, state: { callCount: number }) => {
			const response =
				state.callCount === 1
					? supervisorResponse
					: state.callCount === 2
						? executorVerifyResponse
						: state.callCount === 3
							? executorCommitResponse
							: presentationResponse;
			return response;
		};
		faux.setResponses([responseForCall, responseForCall, responseForCall, responseForCall, responseForCall]);
		try {
			await runtime.prompt("Verify the candidate through the planning executor.");
			expect(verifier.requests).toHaveLength(1);
			expect(verifier.requests[0]).toMatchObject({
				flag: "MOCK_CANDIDATE",
				challenge_id: "cybench/plan-single-target",
				run_id: "field-run-plan-single",
			});
			expect(verifier.requests[0]).not.toHaveProperty("challenge_id", "");
		} finally {
			runtime.dispose();
			await verifier.close();
		}
	}, 30_000);

	it("recovers once from no-tool and resets the consecutive counter after a real tool call", async () => {
		const { ctfContinuation, faux, runtime } = await createCtfFauxRuntime(temporaryRoot());
		const observedCounters: number[] = [];
		runtime.config.maxTurns = 2;
		faux.setResponses([
			() => {
				observedCounters.push(ctfContinuation.consecutiveNoToolTurns);
				return fauxAssistantMessage("I should inspect the target next.");
			},
			() => {
				observedCounters.push(ctfContinuation.consecutiveNoToolTurns);
				return fauxAssistantMessage(fauxToolCall("task_stop", {}));
			},
		]);
		try {
			await runtime.prompt("Solve this CTF challenge.");
			expect(observedCounters).toEqual([0, 1]);
			expect(ctfContinuation.consecutiveNoToolTurns).toBe(0);
		} finally {
			runtime.dispose();
		}
	}, 20_000);

	it("continues beyond three consecutive no-tool turns until the external budget", async () => {
		const { ctfContinuation, faux, runtime } = await createCtfFauxRuntime(temporaryRoot());
		runtime.config.maxTurns = 5;
		faux.setResponses([
			fauxAssistantMessage("analysis only one"),
			fauxAssistantMessage("analysis only two"),
			fauxAssistantMessage("analysis only three"),
			fauxAssistantMessage("analysis only four"),
			fauxAssistantMessage("analysis only five"),
		]);
		try {
			await runtime.prompt("Solve this CTF challenge.");
			expect(faux.state.callCount).toBe(5);
			expect(ctfContinuation.consecutiveNoToolTurns).toBe(5);
			const guards = runtime.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "secheur-response-guard",
			);
			// The parent budget clears the final queued reminder.
			expect(guards).toHaveLength(4);
			expect(contextText(runtime.session.messages)).toContain("[CTF Action Required]");
			expect(contextText(runtime.session.messages)).toContain("[CTF Action Required: continued recovery]");
		} finally {
			runtime.dispose();
		}
	}, 20_000);

	it("continues truncated output until action or the external budget", async () => {
		const { ctfContinuation, faux, runtime } = await createCtfFauxRuntime(temporaryRoot());
		const observedCounters: number[] = [];
		runtime.config.maxTurns = 4;
		faux.setResponses([
			fauxAssistantMessage("analysis one", { stopReason: "length" }),
			fauxAssistantMessage("analysis two", { stopReason: "length" }),
			fauxAssistantMessage("analysis three", { stopReason: "length" }),
			() => {
				observedCounters.push(ctfContinuation.consecutiveNoToolTurns);
				return fauxAssistantMessage(fauxToolCall("task_stop", {}));
			},
		]);
		try {
			await runtime.prompt("Solve this CTF challenge.");
			expect(observedCounters).toEqual([3]);
			expect(faux.state.callCount).toBeGreaterThanOrEqual(4);
			const guards = runtime.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "secheur-response-guard",
			);
			expect(guards.length).toBeGreaterThanOrEqual(3);
			expect(contextText(runtime.session.messages)).toContain("[CTF Output Truncated]");
		} finally {
			runtime.dispose();
		}
	}, 20_000);

	it("only the external budget ends consecutive truncated outputs", async () => {
		const { ctfContinuation, faux, runtime } = await createCtfFauxRuntime(temporaryRoot());
		runtime.config.maxTurns = 6;
		faux.setResponses(
			Array.from({ length: 6 }, () => fauxAssistantMessage("analysis only", { stopReason: "length" })),
		);
		try {
			await runtime.prompt("Solve this CTF challenge.");
			expect(faux.state.callCount).toBe(6);
			expect(ctfContinuation.consecutiveNoToolTurns).toBe(6);
			expect(
				runtime.session.messages.filter(
					(message) => message.role === "custom" && message.customType === "secheur-response-guard",
				),
			).toHaveLength(5);
		} finally {
			runtime.dispose();
		}
	}, 20_000);

	it("counts only consecutive no-tool turns across tool use", async () => {
		const root = temporaryRoot();
		writeFileSync(join(root, "evidence.txt"), "evidence\n");
		const { ctfContinuation, faux, runtime } = await createCtfFauxRuntime(root);
		const observedCounters: number[] = [];
		runtime.config.maxTurns = 4;
		faux.setResponses([
			() => {
				observedCounters.push(ctfContinuation.consecutiveNoToolTurns);
				return fauxAssistantMessage("analysis before action");
			},
			() => {
				observedCounters.push(ctfContinuation.consecutiveNoToolTurns);
				return fauxAssistantMessage(fauxToolCall("read", { path: join(root, "evidence.txt") }));
			},
			() => {
				observedCounters.push(ctfContinuation.consecutiveNoToolTurns);
				return fauxAssistantMessage("analysis after evidence");
			},
			() => {
				observedCounters.push(ctfContinuation.consecutiveNoToolTurns);
				return fauxAssistantMessage(fauxToolCall("task_stop", {}));
			},
		]);
		try {
			await runtime.prompt("Solve this CTF challenge.");
			expect(observedCounters).toEqual([0, 1, 0, 1]);
			expect(ctfContinuation.consecutiveNoToolTurns).toBe(0);
		} finally {
			runtime.dispose();
		}
	}, 20_000);

	it("does not recover a no-tool turn after CTF verification is accepted", async () => {
		const { ctfContinuation, faux, runtime } = await createCtfFauxRuntime(temporaryRoot());
		ctfContinuation.verificationState = "accepted";
		faux.setResponses([fauxAssistantMessage("verified summary")]);
		try {
			await runtime.prompt("Report the verified result.");
			expect(faux.state.callCount).toBe(1);
			expect(ctfContinuation.consecutiveNoToolTurns).toBe(0);
			expect(
				runtime.session.messages.some(
					(message) => message.role === "custom" && message.customType === "secheur-response-guard",
				),
			).toBe(false);
		} finally {
			runtime.dispose();
		}
	}, 20_000);

	it("continues despite a native verifier infrastructure result", async () => {
		const { ctfContinuation, faux, runtime } = await createCtfFauxRuntime(temporaryRoot());
		runtime.config.maxTurns = 4;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("verify_flag", { flag: "flag{candidate}", challenge_id: "fixture/target" })),
			fauxAssistantMessage("Continue after verifier failure."),
			fauxAssistantMessage("Continue again."),
			fauxAssistantMessage("Continue until the parent budget."),
		]);
		try {
			await runtime.prompt("Verify the candidate flag.");
			expect(faux.state.callCount).toBe(4);
			expect(ctfContinuation.verifierInfraError).toContain("invalid_request");
			expect(
				runtime.session.messages.some(
					(message) => message.role === "custom" && message.customType === "secheur-response-guard",
				),
			).toBe(true);
		} finally {
			runtime.dispose();
		}
	}, 20_000);

	it("fails closed when the mock Oracle config is missing and never uses the home fallback", async () => {
		const root = temporaryRoot();
		const fakeHome = temporaryRoot();
		const fallbackVerifier = await listenMockVerifier({ ok: false, status: "incorrect", verified: false });
		mkdirSync(join(fakeHome, ".config", "secheur-agent"), { recursive: true });
		writeFileSync(
			join(fakeHome, ".config", "secheur-agent", "oracle-client.env"),
			`CTF_ORACLE_SOCKET=${fallbackVerifier.path}\n`,
		);
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		process.env.HOME = fakeHome;
		process.env.USERPROFILE = fakeHome;
		let dispose: (() => void) | undefined;
		try {
			const created = await createCtfFauxRuntime(root);
			dispose = () => created.runtime.dispose();
			created.runtime.config.maxTurns = 1;
			created.faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("verify_flag", { flag: "flag{candidate}", challenge_id: "fixture/missing-config" }),
				),
			]);
			await created.runtime.prompt("Verify the candidate flag.");
			expect(fallbackVerifier.requests).toHaveLength(0);
			expect(created.faux.state.callCount).toBe(1);
			expect(created.ctfContinuation.verifierInfraError).toContain("invalid_request");
		} finally {
			dispose?.();
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = originalUserProfile;
			await fallbackVerifier.close();
		}
	}, 20_000);

	it("does not issue a second verifier request after quota exhaustion", async () => {
		const verifier = await listenMockVerifier({ ok: false, status: "limit_exceeded", verified: false });
		const { ctfContinuation, faux, runtime } = await createCtfFauxRuntime(temporaryRoot(), verifier.path, {
			challengeId: "fixture/quota",
			runId: "field-run-quota",
		});
		runtime.setPermissionMode("bypassPermissions");
		runtime.config.maxTurns = 3;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf synthetic-evidence" })),
			fauxAssistantMessage(fauxToolCall("verify_flag", { flag: "flag{candidate}" })),
			fauxAssistantMessage(fauxToolCall("verify_flag", { flag: "flag{second}" })),
		]);
		try {
			await runtime.prompt("Verify the candidate flag.");
			expect(verifier.requests).toHaveLength(1);
			expect(verifier.requests[0]).toMatchObject({ challenge_id: "fixture/quota", run_id: "field-run-quota" });
			expect(faux.state.callCount).toBe(2);
			expect(ctfContinuation.verificationAttemptsRemaining).toBe(0);
			expect(ctfContinuation.verifierInfraError).toContain("quota_exhausted");
		} finally {
			runtime.dispose();
			await verifier.close();
		}
	}, 20_000);
	it("stops when three verification requests exhaust the allowance", async () => {
		const verifier = await listenMockVerifier({ ok: true, status: "incorrect", verified: false });
		const { faux, runtime, ctfContinuation } = await createCtfFauxRuntime(temporaryRoot(), verifier.path, {
			challengeId: "fixture/evidence",
			runId: "run-evidence",
		});
		runtime.setPermissionMode("bypassPermissions");
		runtime.config.maxTurns = 12;
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bash", { command: "sleep 5; printf late-background-result", run_in_background: true }),
			),
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf evidence-A" })),
			fauxAssistantMessage(fauxToolCall("verify_flag", { flag: "mock-one" })),
			fauxAssistantMessage(fauxToolCall("check_flag", { flag: "mock-two" })),
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf evidence-B" })),
			fauxAssistantMessage(fauxToolCall("check_flag", { flag: "mock-two" })),
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf evidence-C" })),
			fauxAssistantMessage(fauxToolCall("verify_flag", { flag: "mock-three" })),
			fauxAssistantMessage(fauxToolCall("verify_flag", { flag: "mock-four-never-sent" })),
			fauxAssistantMessage("continue at zero quota"),
			fauxAssistantMessage("continue again"),
			fauxAssistantMessage("parent budget boundary"),
		]);
		try {
			await runtime.prompt("Exercise generic verification controls.");
			expect(verifier.requests).toHaveLength(3);
			expect(faux.state.callCount).toBe(8);
			expect(runtime.state.commandTasks?.pendingCount).toBe(0);
			expect(contextText(runtime.session.messages)).toContain("duplicate");
			expect(ctfContinuation.verificationAttemptsRemaining).toBe(0);
			expect(ctfContinuation.verifierInfraError).toBeUndefined();
		} finally {
			runtime.dispose();
			await verifier.close();
		}
	}, 20_000);
	it("restores a checkpoint throughout continued recovery without resetting parent turns", async () => {
		const { faux, runtime } = await createCtfFauxRuntime(temporaryRoot(), undefined, {
			challengeId: "fixture/recovery",
			runId: "run-recovery",
		});
		runtime.state.operationalGuard?.observe(
			"update_working_checkpoint",
			{ note: "synthetic-checkpoint" },
			"saved",
			false,
		);
		runtime.config.maxTurns = 5;
		faux.setResponses([
			fauxAssistantMessage("no tools"),
			fauxAssistantMessage("still no tools"),
			fauxAssistantMessage("must continue"),
			fauxAssistantMessage("continue again"),
			fauxAssistantMessage("outer boundary"),
		]);
		try {
			await runtime.prompt("Exercise bounded operational recovery.");
			expect(faux.state.callCount).toBe(5);
			expect(contextText(runtime.session.messages)).toContain("synthetic-checkpoint");
			expect(runtime.getBudgetStatus().turnsUsed).toBe(5);
			expect(runtime.state.operationalGuard?.turnsUsed).toBe(5);
		} finally {
			runtime.dispose();
		}
	}, 20_000);
	it("rejects further model requests when durable turn or cost budgets are exhausted", async () => {
		const { faux, runtime } = await createCtfFauxRuntime(temporaryRoot(), undefined, {
			challengeId: "fixture/budget",
			runId: "run-budget",
		});
		try {
			runtime.state.operationalGuard?.setTurnsUsed(10);
			runtime.config.maxTurns = 10;
			await expect(runtime.prompt("Must not grant another turn.")).rejects.toThrow("turn budget already exhausted");
			runtime.state.operationalGuard?.setTurnsUsed(0);
			runtime.state.operationalGuard?.setCostUsed(0.3);
			runtime.config.maxCost = 0.2;
			await expect(runtime.prompt("Must not grant more cost.")).rejects.toThrow("cost budget already exhausted");
			expect(faux.state.callCount).toBe(0);
		} finally {
			runtime.dispose();
		}
	}, 20_000);
	it("rebuilds the real runtime with saved budgets and delivers a previously queued result once", async () => {
		const root = temporaryRoot();
		const identity = { challengeId: "fixture/restart", runId: "run-restart" };
		const first = await createCtfFauxRuntime(root, undefined, identity);
		const guard = first.runtime.state.operationalGuard;
		expect(guard).toBeDefined();
		guard?.observe("bash", {}, [{ type: "text", text: "original evidence" }], false);
		expect(guard?.reserveVerification("already-sent")).toBe("allowed");
		guard?.setTurnsUsed(7);
		const stateDir = first.runtime.config.stateDir;
		first.runtime.dispose();
		const scope = `${identity.runId}:${identity.challengeId}:${first.runtime.config.projectRoot}:0`;
		const tasks = new BackgroundCommands(stateDir, () => {}, scope);
		const result = await tasks.run("bash", { run_in_background: true }, undefined, async () => ({
			content: [{ type: "text", text: "restored-synthetic-output" }],
			details: {},
		}));
		await new Promise((resolve) => setTimeout(resolve, 25));
		const id = (result.details as { task_id: string }).task_id;
		tasks.markEnqueued([id]);
		const { faux, runtime } = await createCtfFauxRuntime(root, undefined, identity);
		runtime.config.maxTurns = 10;
		faux.setResponses([
			fauxAssistantMessage("no new tools"),
			fauxAssistantMessage("end bounded recovery"),
			fauxAssistantMessage("must not repeat forever"),
		]);
		try {
			expect(runtime.getBudgetStatus().turnsUsed).toBe(7);
			expect(runtime.state.operationalGuard?.remainingAttempts).toBe(2);
			await runtime.prompt("Resume generic harness state.");
			const notices = runtime.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "secheur-command-completion",
			);
			expect(notices).toHaveLength(1);
			expect(contextText(notices)).toContain("restored-synthetic-output");
			expect(runtime.state.commandTasks?.undeliveredCount).toBe(0);
			expect(runtime.getBudgetStatus().turnsUsed).toBeGreaterThan(7);
		} finally {
			runtime.dispose();
			await tasks.close();
		}
	}, 20_000);
	it("uses the configured Python for shell commands and legacy execution", async () => {
		const { faux, runtime } = await createCtfFauxRuntime(temporaryRoot());
		runtime.setPermissionMode("bypassPermissions");
		runtime.config.maxTurns = 3;
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bash", { command: "python3 -c 'import os,sys; print(os.path.realpath(sys.executable))'" }),
			),
			fauxAssistantMessage(
				fauxToolCall("code_run", { script: "import os,sys; print(os.path.realpath(sys.executable))" }),
			),
			fauxAssistantMessage("generic environment check complete"),
		]);
		try {
			await runtime.prompt("Check runtime environment parity.");
			const results = runtime.session.messages.filter(
				(message) =>
					message.role === "toolResult" && (message.toolName === "bash" || message.toolName === "code_run"),
			);
			expect(results).toHaveLength(2);
			for (const result of results)
				expect(contextText([result])).toContain(realpathSync(runtime.config.pythonExecutable));
		} finally {
			runtime.dispose();
		}
	}, 20_000);
	it("cancels a SIGTERM-resistant legacy job without leaving an orphan or killing the IPC host", async () => {
		if (process.platform === "win32") return;
		const root = temporaryRoot();
		const { faux, runtime } = await createCtfFauxRuntime(root);
		runtime.setPermissionMode("bypassPermissions");
		runtime.config.maxTurns = 10;
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("code_run", {
					script:
						"import os,signal,time; from pathlib import Path; signal.signal(signal.SIGTERM, signal.SIG_IGN); Path('stubborn.pid').write_text(str(os.getpid())); time.sleep(60)",
					run_in_background: true,
				}),
			),
			fauxAssistantMessage("background still processing"),
		]);
		const prompt = runtime.prompt("Exercise cancellation of a synthetic process.");
		try {
			await new Promise<void>((resolve, reject) => {
				const deadline = Date.now() + 5000;
				const poll = () => {
					try {
						if (readFileSync(join(root, "stubborn.pid"), "utf8")) {
							resolve();
							return;
						}
					} catch {}
					if (Date.now() > deadline) {
						reject(new Error("synthetic process did not start"));
						return;
					}
					setTimeout(poll, 25);
				};
				poll();
			});
			const pid = Number(readFileSync(join(root, "stubborn.pid"), "utf8"));
			const started = Date.now();
			await runtime.abort("synthetic parent cancellation");
			expect(Date.now() - started).toBeLessThan(6500);
			await prompt;
			expect(() => process.kill(pid, 0)).toThrow();
			const response = await runtime.state.legacyHost.call("code_run", { script: "print('ipc-responsive')" });
			expect(response.ok).toBe(true);
		} finally {
			await runtime.abort();
			runtime.dispose();
			await prompt.catch(() => undefined);
		}
	}, 20_000);

	it("continues no-tool turns without active tools until the parent budget", async () => {
		const { ctfContinuation, faux, runtime } = await createCtfFauxRuntime(temporaryRoot());
		runtime.setKnowledgeBaseEnabled(false);
		runtime.session.setActiveToolsByName([]);
		faux.setResponses([fauxAssistantMessage("Planning produced no candidate; summarize the result.")]);
		try {
			await runtime.prompt("Summarize this CTF planning result without a flag candidate.");
			expect(faux.state.callCount).toBe(12);
			expect(ctfContinuation.consecutiveNoToolTurns).toBe(12);
			expect(
				runtime.session.messages.some(
					(message) => message.role === "custom" && message.customType === "secheur-response-guard",
				),
			).toBe(true);
		} finally {
			runtime.dispose();
		}
	}, 20_000);

	it("carries native tool evidence into supervision and rejects an unsupported flag", async () => {
		const root = temporaryRoot();
		const stateDir = join(root, ".secheur-agent");
		const rulesDir = join(stateDir, "rules");
		mkdirSync(rulesDir, { recursive: true });
		writeFileSync(join(rulesDir, "runtime.md"), "RUNTIME_E2E_PROJECT_RULE\n");
		writeFileSync(join(root, "evidence.txt"), "verified local evidence\n");

		const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.refresh({ allowNetwork: false });

		let firstSystemPrompt = "";
		let secondContext = "";
		let guardedContext = "";
		let agentCallCount = 0;
		let judgeCallCount = 0;
		const response = (context: Context, options: SimpleStreamOptions | undefined) => {
			if (options?.maxTokens === 700) {
				judgeCallCount += 1;
				return fauxAssistantMessage(
					JSON.stringify({
						status: "on_track",
						summary: "Test progress is on track.",
						suggestion: "",
						confidence: 1,
					}),
				);
			}
			agentCallCount += 1;
			if (agentCallCount === 1) {
				firstSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage(fauxToolCall("read", { path: join(root, "evidence.txt") }));
			}
			if (agentCallCount === 2) {
				secondContext = contextText(context.messages);
				return fauxAssistantMessage("The answer is flag{unsupported_guess}.");
			}
			if (agentCallCount === 3) {
				guardedContext = contextText(context.messages);
				return fauxAssistantMessage("More evidence is required before completion.");
			}
			throw new Error(`Unexpected Agent request ${agentCallCount}`);
		};
		faux.setResponses(Array.from({ length: 10 }, () => response));

		const runtime = await createSecHeurRuntime({
			projectRoot: root,
			stateDir,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			persist: false,
			model: faux.getModel(),
			modelRuntime,
			env: {
				PATH: process.env.PATH,
				PI_OFFLINE: "1",
				SECHEUR_PYTHON: resolve(import.meta.dirname, "../../../.secheur-agent/python/bin/python"),
			},
		});
		try {
			await runtime.prompt("Inspect the local evidence, verify any answer, and report the result.");

			expect(agentCallCount).toBe(3);
			expect(faux.state.callCount).toBe(agentCallCount + judgeCallCount);
			expect(firstSystemPrompt).toContain("RUNTIME_E2E_PROJECT_RULE");
			expect(firstSystemPrompt).toContain("[Evidence-Grounded Program Plan]");
			expect(secondContext).toContain("verified local evidence");
			expect(secondContext).toContain("Task Tree Status");
			expect(guardedContext).toContain("答案门禁");

			const sessionRuntimeDir = join(stateDir, "runtime", "sessions", runtime.session.sessionId);
			const taskDirName = readdirSync(sessionRuntimeDir).find((name) => name.startsWith("task-"));
			expect(taskDirName).toBeDefined();
			const taskDir = join(sessionRuntimeDir, taskDirName as string);
			const taskTree = JSON.parse(readFileSync(join(taskDir, "task_tree.json"), "utf8")) as {
				nodes?: Array<{ tool?: string }>;
			};
			expect(taskTree.nodes?.some((node) => node.tool === "read")).toBe(true);
		} finally {
			runtime.dispose();
		}
	}, 20_000);
});
