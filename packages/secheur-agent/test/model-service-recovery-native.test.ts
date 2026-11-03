import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { type InlineExtension, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { PiCodingSessionOwner, runPiCodingTask } from "../src/subagent.ts";

const history = JSON.parse(
	readFileSync(join(import.meta.dirname, "fixtures/provider-recovery-history.json"), "utf8"),
) as {
	records: Array<{ payload: { error: string } }>;
};
const quotaErrors = history.records.filter((record) => record.payload.error.includes("2056"));

it.each([
	'400: {"error":{"message":"Invalid schema for function \'conclude_intent\': schema must be a JSON Schema of type object, got type null","type":"invalid_request_error"}}',
	'422: {"error":{"message":"Unsupported message role","type":"invalid_request_error"}}',
])("rejects permanent request errors without waiting, retrying or repairing (%s)", async (errorMessage) => {
	const f = await setup();
	f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);
	try {
		await expect(runPiCodingTask(f.options)).rejects.toMatchObject({
			code: "model_invalid_request",
			stage: "executor",
		});
		expect(f.faux.state.callCount).toBe(1);
		expect(f.owner.inUse).toBe(false);
		expect(f.controller.signal.aborted).toBe(false);
		expect(f.events.some((event) => event.type === "model_request_rejected")).toBe(true);
		expect(
			f.events.some((event) =>
				["model_service_wait", "model_service_resume", "required_tool_recovery_start", "auto_retry_start"].includes(
					event.type,
				),
			),
		).toBe(false);
	} finally {
		f.controller.abort();
		f.owner.dispose();
		rmSync(f.root, { recursive: true, force: true });
	}
});

async function setup() {
	const root = mkdtempSync(join(tmpdir(), "model-service-native-"));
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
	mkdirSync(config.agentDir, { recursive: true });
	// Shorten test time only; exercise Pi's own two retries and exponential delay.
	writeFileSync(
		join(config.agentDir, "settings.json"),
		JSON.stringify({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } }),
	);
	const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
	const results = vi.fn();
	const controller = new AbortController();
	const owner = new PiCodingSessionOwner();
	const extension: InlineExtension = (pi) => {
		pi.registerTool({
			name: "required_result",
			label: "Persist result",
			description: "Persist the owned task result",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text" as const, text: "persisted" }],
				details: { accepted: true },
			}),
		});
	};
	const options = {
		config,
		cwd: root,
		task: "Keep the current synthetic task and its saved observations",
		role: "executor" as const,
		model: faux.getModel(),
		modelRuntime,
		thinkingLevel: "off" as const,
		requiredToolName: "required_result",
		requiredToolRecoveryAttempts: 2,
		continueUntilRequiredTool: true,
		handoffOnRequiredTool: true,
		isolatedRoleResources: true,
		allowedTools: ["required_result"],
		signal: controller.signal,
		sessionOwner: owner,
		onLifecycleEvent: (type: string, payload: Record<string, unknown> = {}) => events.push({ type, payload }),
		onToolExecution: results,
		extensionFactories: [extension],
	};
	return { root, faux, events, results, controller, owner, options };
}

it.each(quotaErrors)(
	"holds historical quota error without protocol repair or provider probes ($payload.error)",
	async ({ payload }) => {
		const f = await setup();
		let completed = false;
		f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: payload.error })]);
		const pending = runPiCodingTask(f.options).then(
			(value) => {
				completed = true;
				return value;
			},
			(error) => {
				completed = true;
				return error;
			},
		);
		try {
			await vi.waitFor(() => {
				expect(f.faux.state.callCount).toBe(1);
				expect(f.events.some((e) => e.type === "model_service_wait")).toBe(true);
			});
			expect(completed).toBe(false);
			expect(f.owner.inUse).toBe(true);
			expect(f.faux.state.callCount).toBe(1);
			expect(f.events.some((e) => e.type === "auto_retry_start" || e.type === "required_tool_recovery_start")).toBe(
				false,
			);
			expect(f.events.find((e) => e.type === "model_service_wait")?.payload.reason).toBe("provider_quota_exhausted");
			const boundary = new Error("existing outer deadline");
			f.controller.abort(boundary);
			expect(await pending).toBe(boundary);
		} finally {
			f.controller.abort(new Error("test cleanup"));
			await pending;
			f.owner.dispose();
			rmSync(f.root, { recursive: true, force: true });
		}
	},
);

it("transient provider errors recover through native Pi retries in the same task, without repair prompts", async () => {
	const f = await setup();
	f.faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "429: too many requests" }),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "502 status code (no body)" }),
		fauxAssistantMessage(fauxToolCall("required_result", {}), { stopReason: "toolUse" }),
	]);
	try {
		await runPiCodingTask(f.options);
		expect(f.faux.state.callCount).toBe(3);
		expect(f.results).toHaveBeenCalledOnce();
		expect(f.events.filter((e) => e.type === "auto_retry_start").map((e) => e.payload.delayMs)).toEqual([1, 2]);
		expect(f.events.some((e) => e.type === "required_tool_recovery_start" || e.type === "model_service_wait")).toBe(
			false,
		);
	} finally {
		f.controller.abort();
		f.owner.dispose();
		rmSync(f.root, { recursive: true, force: true });
	}
});

it("after native retries fail, the existing owner resumes the same task with backoff, without protocol repair", async () => {
	const f = await setup();
	f.faux.setResponses([
		...Array.from({ length: 3 }, () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
		),
		fauxAssistantMessage(fauxToolCall("required_result", {}), { stopReason: "toolUse" }),
	]);
	try {
		await runPiCodingTask(f.options);
		expect(f.faux.state.callCount).toBe(4);
		expect(f.results).toHaveBeenCalledOnce();
		expect(f.events.filter((e) => e.type === "coding_task_start")).toHaveLength(1);
		expect(f.events.filter((e) => e.type === "model_service_resume").map((e) => e.payload.delayMs)).toEqual([2]);
		expect(f.events.some((e) => e.type === "required_tool_recovery_start")).toBe(false);
	} finally {
		f.controller.abort();
		f.owner.dispose();
		rmSync(f.root, { recursive: true, force: true });
	}
});

it.each(["stop", "length"] as const)(
	"normal %s response without a report still uses required-result repair",
	async (stopReason) => {
		const f = await setup();
		f.faux.setResponses([
			fauxAssistantMessage("saved partial observation", { stopReason }),
			fauxAssistantMessage(fauxToolCall("required_result", {}), { stopReason: "toolUse" }),
		]);
		try {
			await runPiCodingTask(f.options);
			expect(f.faux.state.callCount).toBe(2);
			expect(f.events.filter((e) => e.type === "required_tool_recovery_attempt_start")).toHaveLength(1);
			expect(f.events.some((e) => e.type === "model_service_wait")).toBe(false);
		} finally {
			f.controller.abort();
			f.owner.dispose();
			rmSync(f.root, { recursive: true, force: true });
		}
	},
);

it("an error during protocol repair does not start the next repair attempt", async () => {
	const f = await setup();
	f.faux.setResponses([
		fauxAssistantMessage("saved partial observation"),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: quotaErrors[0].payload.error }),
	]);
	const pending = runPiCodingTask(f.options).catch((error) => error);
	try {
		await vi.waitFor(() => expect(f.events.some((e) => e.type === "model_service_wait")).toBe(true));
		expect(f.faux.state.callCount).toBe(2);
		expect(f.events.filter((e) => e.type === "required_tool_recovery_attempt_start")).toHaveLength(1);
		expect(f.owner.inUse).toBe(true);
	} finally {
		f.controller.abort();
		await pending;
		f.owner.dispose();
		rmSync(f.root, { recursive: true, force: true });
	}
});

it("an already accepted report wins over a subsequent provider error", async () => {
	const f = await setup();
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("required_result", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: quotaErrors[0].payload.error }),
	]);
	try {
		const result = await runPiCodingTask({ ...f.options, handoffOnRequiredTool: false });
		expect(result.toolExecutions).toHaveLength(1);
		expect(f.faux.state.callCount).toBe(2);
		expect(f.events.some((e) => e.type === "required_tool_recovery_start" || e.type === "model_service_wait")).toBe(
			false,
		);
	} finally {
		f.controller.abort();
		f.owner.dispose();
		rmSync(f.root, { recursive: true, force: true });
	}
});

it("one waiting executor does not stop another executor", async () => {
	const first = await setup(),
		second = await setup();
	first.faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: quotaErrors[0].payload.error }),
	]);
	second.faux.setResponses([fauxAssistantMessage(fauxToolCall("required_result", {}), { stopReason: "toolUse" })]);
	const pending = runPiCodingTask(first.options).catch((error) => error);
	try {
		await vi.waitFor(() => expect(first.events.some((e) => e.type === "model_service_wait")).toBe(true));
		await runPiCodingTask(second.options);
		expect(second.results).toHaveBeenCalledOnce();
		expect(first.owner.inUse).toBe(true);
		expect(first.faux.state.callCount).toBe(1);
	} finally {
		first.controller.abort();
		second.controller.abort();
		await pending;
		first.owner.dispose();
		second.owner.dispose();
		rmSync(first.root, { recursive: true, force: true });
		rmSync(second.root, { recursive: true, force: true });
	}
});

it("a background result settles and is captured after the provider fails, without cancelling it", async () => {
	const f = await setup();
	let live = true,
		finish = () => {};
	const settlement = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const outputs: NonNullable<Awaited<ReturnType<typeof runPiCodingTask>>>["toolExecutions"] = [];
	const background = { hasPending: () => live, waitForSettlement: () => settlement, settledExecutions: () => outputs };
	f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: quotaErrors[0].payload.error })]);
	const pending = runPiCodingTask({ ...f.options, backgroundTasks: background }).catch((error) => error);
	try {
		await vi.waitFor(() => expect(f.faux.state.callCount).toBe(1));
		expect(live).toBe(true);
		outputs.push({
			toolCallId: "original-background-call",
			toolName: "read",
			result: { content: [{ type: "text", text: "original background output" }] },
			isError: false,
			backgroundCompletion: true,
		});
		live = false;
		finish();
		await vi.waitFor(() => expect(f.events.some((e) => e.type === "model_service_wait")).toBe(true));
		expect(f.results).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "original-background-call" }));
		expect(f.faux.state.callCount).toBe(1);
		expect(f.owner.inUse).toBe(true);
	} finally {
		finish();
		f.controller.abort();
		await pending;
		f.owner.dispose();
		rmSync(f.root, { recursive: true, force: true });
	}
});

it("a one-shot planning request repairs its missing submission after service continuation succeeds", async () => {
	const f = await setup();
	f.faux.setResponses([
		...Array.from({ length: 3 }, () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
		),
		fauxAssistantMessage("request now works; saved observation retained"),
		fauxAssistantMessage(fauxToolCall("required_result", {}), { stopReason: "toolUse" }),
	]);
	try {
		await runPiCodingTask({ ...f.options, role: "planner", continueUntilRequiredTool: false });
		expect(f.faux.state.callCount).toBe(5);
		expect(f.events.filter((e) => e.type === "model_service_resume")).toHaveLength(1);
		expect(f.events.filter((e) => e.type === "required_tool_recovery_attempt_start")).toHaveLength(1);
		expect(f.results).toHaveBeenCalledOnce();
	} finally {
		f.controller.abort();
		f.owner.dispose();
		rmSync(f.root, { recursive: true, force: true });
	}
});

it("an unknown service error waits without inventing a quota or transport diagnosis", async () => {
	const f = await setup();
	f.faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "unknown provider diagnostic" }),
	]);
	const pending = runPiCodingTask(f.options).catch((error) => error);
	try {
		await vi.waitFor(() => expect(f.events.some((e) => e.type === "model_service_wait")).toBe(true));
		expect(f.events.find((e) => e.type === "model_service_wait")?.payload.reason).toBe("model_request_failed");
		expect(f.faux.state.callCount).toBe(1);
		expect(f.owner.inUse).toBe(true);
		expect(f.events.some((e) => e.type === "required_tool_recovery_start")).toBe(false);
	} finally {
		f.controller.abort();
		await pending;
		f.owner.dispose();
		rmSync(f.root, { recursive: true, force: true });
	}
});

it("does not create an unbounded wait for a standalone request without an outer boundary", async () => {
	const f = await setup();
	f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: quotaErrors[0].payload.error })]);
	try {
		await expect(runPiCodingTask({ ...f.options, signal: undefined })).rejects.toThrow(
			"without an outer wait boundary",
		);
		expect(f.events.some((e) => e.type === "required_tool_recovery_start")).toBe(false);
		expect(f.faux.state.callCount).toBe(1);
	} finally {
		f.controller.abort();
		f.owner.dispose();
		rmSync(f.root, { recursive: true, force: true });
	}
});

it("existing request admission rejects continuation before another provider call", async () => {
	const f = await setup();
	f.faux.setResponses(
		Array.from({ length: 3 }, () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
		),
	);
	const boundary = new Error("existing outer budget exhausted");
	try {
		await expect(
			runPiCodingTask({
				...f.options,
				beforeModelRequest: async () => {
					if (f.faux.state.callCount >= 3) throw boundary;
				},
			}),
		).rejects.toBe(boundary);
		expect(f.faux.state.callCount).toBe(3);
		expect(f.events.some((e) => e.type === "required_tool_recovery_start")).toBe(false);
	} finally {
		f.controller.abort();
		f.owner.dispose();
		rmSync(f.root, { recursive: true, force: true });
	}
});

it("rechecks an authoritative completion received during backoff before resuming the model", async () => {
	const f = await setup();
	let complete = false;
	f.faux.setResponses(
		Array.from({ length: 3 }, () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
		),
	);
	try {
		await runPiCodingTask({
			...f.options,
			isRequiredToolComplete: () => complete,
			onLifecycleEvent: (type, payload = {}) => {
				f.options.onLifecycleEvent(type, payload);
				if (type === "model_service_resume") {
					writeFileSync(
						join(f.root, "durable-result.json"),
						JSON.stringify({ accepted: true, origin: "owned-background-result" }),
					);
					complete = true;
				}
			},
		});
		expect(f.faux.state.callCount).toBe(3);
		expect(f.events.some((e) => e.type === "required_tool_recovery_start")).toBe(false);
	} finally {
		f.controller.abort();
		f.owner.dispose();
		rmSync(f.root, { recursive: true, force: true });
	}
});

it("known hard quota blocks another session on the same credential without cancelling either owner", async () => {
	const a = await setup(),
		b = await setup();
	a.faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: quotaErrors[0].payload.error }),
		fauxAssistantMessage(fauxToolCall("required_result", {}), { stopReason: "toolUse" }),
	]);
	const first = runPiCodingTask(a.options).catch((error) => error);
	let second: Promise<unknown> | undefined;
	try {
		await vi.waitFor(() => expect(a.events.some((e) => e.type === "model_service_wait")).toBe(true));
		second = runPiCodingTask({ ...b.options, modelRuntime: a.options.modelRuntime, model: a.options.model }).catch(
			(error) => error,
		);
		await vi.waitFor(() => expect(b.events.some((e) => e.type === "model_service_wait")).toBe(true));
		expect(a.faux.state.callCount).toBe(1);
		expect(b.faux.state.callCount).toBe(0);
		expect(a.owner.inUse).toBe(true);
		expect(b.owner.inUse).toBe(true);
		b.controller.abort(new Error("existing second outer boundary"));
		await second;
		expect(a.owner.inUse).toBe(true);
	} finally {
		a.controller.abort();
		b.controller.abort();
		await first;
		await second;
		expect(
			a.events.some((e) => e.type === "model_service_wait_end" && typeof e.payload.waitElapsedMs === "number"),
		).toBe(true);
		a.owner.dispose();
		b.owner.dispose();
		rmSync(a.root, { recursive: true, force: true });
		rmSync(b.root, { recursive: true, force: true });
	}
});
