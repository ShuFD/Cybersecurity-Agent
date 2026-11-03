import { describe, expect, it } from "vitest";
import { buildTrajectory, mergeRuntimeLogPayload } from "../src/trajectory.ts";
import type { RuntimeLogPayload, SessionSummary } from "../src/types.ts";

function session(status: SessionSummary["status"] = "idle"): SessionSummary {
	return {
		id: "session-1",
		title: "Test session",
		cwd: "/workspace",
		createdAt: 1_700_000_000,
		updatedAt: 1_700_000_001,
		status,
		role: "main",
		managed: false,
		taskId: null,
		category: null,
		msgSeq: 0,
		permissionMode: "default",
		persistent: false,
		closed: false,
		lastError: "",
		turnCount: 0,
		watchdogPhase: null,
	};
}

function payload(
	messages: RuntimeLogPayload["messages"] = [],
	events: RuntimeLogPayload["events"] = [],
	status: SessionSummary["status"] = "idle",
): RuntimeLogPayload {
	return { sessionId: "session-1", session: session(status), messages, partial: null, events };
}

describe("buildTrajectory", () => {
	it("merges runtime tool start/end into one completed record", () => {
		const result = buildTrajectory(
			payload(
				[],
				[
					{ id: 1, event: "turn_start", timestamp: 1_700_000_002 },
					{
						id: 2,
						event: "tool_execution_start",
						timestamp: 1_700_000_003,
						toolCallId: "call-1",
						toolName: "shell",
						argsText: '{"command":"id"}',
					},
					{
						id: 3,
						event: "tool_execution_end",
						timestamp: 1_700_000_004,
						toolCallId: "call-1",
						toolName: "shell",
						resultText: "uid=1000",
					},
				],
			),
		);
		const tools = result.records.filter((record) => record.kind === "tool");
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({
			toolCallId: "call-1",
			toolName: "shell",
			requestText: '{\n  "command": "id"\n}',
			resultText: "uid=1000",
			running: false,
		});
	});

	it("keeps a start-only tool visible while the session is running", () => {
		const result = buildTrajectory(
			payload(
				[],
				[
					{
						id: 2,
						event: "tool_execution_start",
						timestamp: 1_700_000_003,
						toolCallId: "call-2",
						toolName: "gdb",
						argsText: "{}",
					},
				],
				"running",
			),
		);
		const tools = result.records.filter((record) => record.kind === "tool");
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ toolCallId: "call-2", running: true, resultText: "" });
	});

	it("does not duplicate a runtime tool when the transcript also has the call and result", () => {
		const result = buildTrajectory(
			payload(
				[
					{
						id: 2,
						role: "assistant",
						content: "",
						ts: 1_700_000_003,
						toolCalls: [{ id: "call-3", name: "shell", argsText: '{"command":"pwd"}' }],
					},
					{
						id: 3,
						role: "toolResult",
						content: " /workspace",
						ts: 1_700_000_004,
						toolCallId: "call-3",
						toolName: "shell",
					},
				],
				[
					{
						id: 4,
						event: "tool_execution_start",
						timestamp: 1_700_000_003,
						toolCallId: "call-3",
						toolName: "shell",
						argsText: '{"command":"pwd"}',
					},
					{
						id: 5,
						event: "tool_execution_end",
						timestamp: 1_700_000_004,
						toolCallId: "call-3",
						toolName: "shell",
						resultText: " /workspace",
					},
				],
			),
		);
		expect(result.records.filter((record) => record.kind === "tool")).toHaveLength(1);
		expect(result.calls).toBe(1);
	});

	it("does not duplicate a still-running runtime tool when only the call is persisted", () => {
		const result = buildTrajectory(
			payload(
				[
					{
						id: 2,
						role: "assistant",
						content: "",
						ts: 1_700_000_003,
						toolCalls: [{ id: "call-4", name: "gdb", argsText: "{}" }],
					},
				],
				[
					{
						id: 4,
						event: "tool_execution_start",
						timestamp: 1_700_000_003,
						toolCallId: "call-4",
						toolName: "gdb",
						argsText: "{}",
					},
				],
				"running",
			),
		);
		expect(result.records.filter((record) => record.kind === "tool")).toHaveLength(1);
	});

	it("merges an end event that arrives before its start", () => {
		const result = buildTrajectory(
			payload(
				[],
				[
					{
						id: 8,
						event: "tool_execution_end",
						timestamp: 1_700_000_003,
						toolCallId: "call-5",
						toolName: "shell",
						resultText: "done",
					},
					{
						id: 9,
						event: "tool_execution_start",
						timestamp: 1_700_000_004,
						toolCallId: "call-5",
						toolName: "shell",
						argsText: "{}",
					},
				],
			),
		);
		const tools = result.records.filter((record) => record.kind === "tool");
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ toolCallId: "call-5", requestText: "{}", resultText: "done" });
	});

	it("keeps reused tool call ids separate across turns", () => {
		const result = buildTrajectory(
			payload(
				[],
				[
					{ id: 1, event: "turn_start", timestamp: 1_700_000_001 },
					{
						id: 2,
						event: "tool_execution_start",
						timestamp: 1_700_000_002,
						toolCallId: "reused",
						toolName: "shell",
						argsText: "one",
					},
					{
						id: 3,
						event: "tool_execution_end",
						timestamp: 1_700_000_003,
						toolCallId: "reused",
						toolName: "shell",
						resultText: "result-one",
					},
					{ id: 4, event: "turn_start", timestamp: 1_700_000_004 },
					{
						id: 5,
						event: "tool_execution_start",
						timestamp: 1_700_000_005,
						toolCallId: "reused",
						toolName: "shell",
						argsText: "two",
					},
					{
						id: 6,
						event: "tool_execution_end",
						timestamp: 1_700_000_006,
						toolCallId: "reused",
						toolName: "shell",
						resultText: "result-two",
					},
				],
			),
		);
		const tools = result.records.filter((record) => record.kind === "tool");
		expect(tools).toHaveLength(2);
		expect(tools.map((tool) => tool.resultText)).toEqual(["result-one", "result-two"]);
		expect(tools.map((tool) => tool.turn)).toEqual([1, 2]);
	});

	it("does not reuse raw-id runtime records when legacy events omit turn metadata", () => {
		const result = buildTrajectory(
			payload(
				[
					{ id: 1, role: "user", content: "first", ts: 1_700_000_001 },
					{
						id: 2,
						role: "assistant",
						content: "",
						ts: 1_700_000_002,
						toolCalls: [{ id: "legacy-id", name: "shell", argsText: "first" }],
					},
					{ id: 3, role: "toolResult", content: "out-first", ts: 1_700_000_003, toolCallId: "legacy-id" },
					{ id: 4, role: "user", content: "second", ts: 1_700_000_004 },
					{
						id: 5,
						role: "assistant",
						content: "",
						ts: 1_700_000_005,
						toolCalls: [{ id: "legacy-id", name: "shell", argsText: "second" }],
					},
					{ id: 6, role: "toolResult", content: "out-second", ts: 1_700_000_006, toolCallId: "legacy-id" },
				],
				[
					{
						id: 1,
						event: "tool_execution_start",
						timestamp: 1_700_000_002,
						toolCallId: "legacy-id",
						toolName: "shell",
						argsText: "first",
					},
					{
						id: 2,
						event: "tool_execution_end",
						timestamp: 1_700_000_003,
						toolCallId: "legacy-id",
						toolName: "shell",
						resultText: "out-first",
					},
					{
						id: 3,
						event: "tool_execution_start",
						timestamp: 1_700_000_005,
						toolCallId: "legacy-id",
						toolName: "shell",
						argsText: "second",
					},
					{
						id: 4,
						event: "tool_execution_end",
						timestamp: 1_700_000_006,
						toolCallId: "legacy-id",
						toolName: "shell",
						resultText: "out-second",
					},
				],
			),
		);
		const tools = result.records.filter((record) => record.kind === "tool");
		expect(tools).toHaveLength(2);
		expect(tools.map((tool) => tool.resultText)).toEqual(["out-first", "out-second"]);
	});

	it("keeps repeated tool calls separate within one turn", () => {
		const result = buildTrajectory(
			payload(
				[],
				[
					{ id: 1, event: "turn_start", timestamp: 1_700_000_001 },
					{
						id: 2,
						event: "tool_execution_start",
						timestamp: 1_700_000_002,
						toolCallId: "reused",
						toolName: "shell",
						argsText: "one",
					},
					{
						id: 3,
						event: "tool_execution_end",
						timestamp: 1_700_000_003,
						toolCallId: "reused",
						toolName: "shell",
						resultText: "result-one",
					},
					{
						id: 4,
						event: "tool_execution_start",
						timestamp: 1_700_000_004,
						toolCallId: "reused",
						toolName: "shell",
						argsText: "two",
					},
					{
						id: 5,
						event: "tool_execution_end",
						timestamp: 1_700_000_005,
						toolCallId: "reused",
						toolName: "shell",
						resultText: "result-two",
					},
				],
			),
		);
		const tools = result.records.filter((record) => record.kind === "tool");
		expect(tools).toHaveLength(2);
		expect(tools.map((tool) => tool.requestText)).toEqual(["one", "two"]);
	});

	it("normalizes timestamps expressed in seconds and milliseconds", () => {
		const result = buildTrajectory(
			payload([
				{ id: 1, role: "user", content: "hello", ts: 1_700_000_002 },
				{ id: 2, role: "assistant", content: "world", ts: 1_700_000_003_000 },
			]),
		);
		const messages = result.records.filter((record) => record.kind === "user" || record.kind === "assistant");
		expect(messages.map((record) => record.timestamp)).toEqual([1_700_000_002_000, 1_700_000_003_000]);
	});

	it("overlays a same-id streaming partial over the persisted message", () => {
		const result = buildTrajectory({
			...payload(
				[
					{
						id: 2,
						role: "assistant",
						content: "old streamed text",
						ts: 1_700_000_002,
						partial: false,
					},
				],
				[],
				"running",
			),
			partial: {
				id: 2,
				role: "assistant",
				content: "new streamed text",
				ts: 1_700_000_003,
				partial: true,
			},
		});
		const assistants = result.records.filter((record) => record.kind === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0]).toMatchObject({ content: "new streamed text", running: true });
	});
});

describe("mergeRuntimeLogPayload", () => {
	it("replaces same-id streaming messages and appends new cursored data", () => {
		const previous = payload(
			[{ id: 1, role: "assistant", content: "draft", ts: 1 }],
			[{ id: 1, event: "message_start", timestamp: 1 }],
		);
		previous.incremental = false;
		previous.logEpoch = "epoch";
		previous.messageCursor = 1;
		previous.eventCursor = 1;
		const merged = mergeRuntimeLogPayload(previous, {
			...payload(
				[
					{ id: 1, role: "assistant", content: "draft updated", ts: 1 },
					{ id: 2, role: "user", content: "next", ts: 2 },
				],
				[{ id: 2, event: "message_end", timestamp: 2 }],
			),
			incremental: true,
			logEpoch: "epoch",
			messageCursor: 2,
			eventCursor: 2,
			messagesIncluded: true,
		});
		expect(merged.messages.map((message) => message.content)).toEqual(["draft updated", "next"]);
		expect(merged.events.map((event) => event.id)).toEqual([1, 2]);
	});

	it("returns a reset payload without merging when the cursor is invalid", () => {
		const previous = payload([{ id: 1, role: "user", content: "old", ts: 1 }]);
		const next = {
			...payload([{ id: 1, role: "user", content: "fresh", ts: 2 }]),
			incremental: true,
			resetRequired: true,
			logEpoch: "new",
		};
		expect(mergeRuntimeLogPayload(previous, next)).toBe(next);
	});

	it("clears a stale partial on a terminal lightweight delta", () => {
		const previous = {
			...payload(
				[{ id: 2, role: "assistant", content: "streaming", ts: 2, partial: true }],
				[{ id: 1, event: "message_start", timestamp: 1 }],
				"running",
			),
			partial: { id: 2, role: "assistant", content: "streaming", ts: 2, partial: true },
			incremental: false,
			messageCursor: 2,
			eventCursor: 1,
			logEpoch: "epoch",
		};
		const next = {
			...payload([], [{ id: 2, event: "remote-complete", timestamp: 3 }], "idle"),
			incremental: true,
			messagesIncluded: false,
			messageCursor: 2,
			eventCursor: 2,
			logEpoch: "epoch",
		};

		expect(mergeRuntimeLogPayload(previous, next).partial).toBeNull();
	});

	it("keeps a partial while a lightweight delta is still running", () => {
		const partial = { id: 2, role: "assistant", content: "streaming", ts: 2, partial: true };
		const previous = {
			...payload([{ ...partial }], [{ id: 1, event: "message_start", timestamp: 1 }], "running"),
			partial,
			incremental: false,
			messageCursor: 2,
			eventCursor: 1,
			logEpoch: "epoch",
		};
		const next = {
			...payload([], [{ id: 2, event: "tool_execution_start", timestamp: 3 }], "running"),
			incremental: true,
			messagesIncluded: false,
			messageCursor: 2,
			eventCursor: 2,
			logEpoch: "epoch",
		};

		expect(mergeRuntimeLogPayload(previous, next).partial).toEqual(partial);
	});

	it("clears a partial when an assistant message ends during a running delta", () => {
		const partial = { id: 2, role: "assistant", content: "done", ts: 2, partial: true };
		const previous = {
			...payload([{ ...partial }], [], "running"),
			partial,
			incremental: false,
			messageCursor: 2,
			eventCursor: 1,
			logEpoch: "epoch",
		};
		const next = {
			...payload([], [{ id: 2, event: "message_end", role: "assistant", timestamp: 3 }], "running"),
			incremental: true,
			messagesIncluded: false,
			messageCursor: 2,
			eventCursor: 2,
			logEpoch: "epoch",
		};

		expect(mergeRuntimeLogPayload(previous, next).partial).toBeNull();
	});
});
