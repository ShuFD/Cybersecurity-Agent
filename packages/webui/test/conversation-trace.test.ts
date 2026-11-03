import { describe, expect, it } from "vitest";
import { buildConversationRows, conversationToolStatus, splitAssistantContent } from "../src/conversation-trace.ts";
import type { BridgeMessage } from "../src/types.ts";

function message(id: number, role: string, content: string, extra: Record<string, unknown> = {}): BridgeMessage {
	return { id, role, content, ts: id, ...extra };
}

describe("conversation trace", () => {
	it("merges a tool call and result by toolCallId at the call position", () => {
		const rows = buildConversationRows([
			message(1, "assistant", "", {
				toolCalls: [{ id: "call-1", name: "shell", argsText: '{"command":"pwd"}' }],
			}),
			message(2, "toolResult", "/workspace", { toolCallId: "call-1", toolName: "shell" }),
			message(3, "assistant", "Done"),
		]);

		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			kind: "tool",
			tool: {
				toolCallId: "call-1",
				toolName: "shell",
				requestText: '{\n  "command": "pwd"\n}',
				resultText: "/workspace",
				status: "complete",
			},
		});
		expect(rows[1]).toMatchObject({ kind: "message", message: { content: "Done" } });
	});

	it("keeps a failed result as one error tool row", () => {
		const rows = buildConversationRows([
			message(1, "assistant", "", {
				toolCalls: [{ id: "call-2", name: "gdb", argsText: "{}" }],
			}),
			message(2, "tool", "process exited with code 1", {
				toolCallId: "call-2",
				toolName: "gdb",
				isError: true,
			}),
		]);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: "tool", tool: { status: "error", isError: true } });
	});

	it("overlays a same-id partial message instead of rendering it twice", () => {
		const rows = buildConversationRows([
			message(1, "assistant", "persisted", { partial: false }),
			message(1, "assistant", "streaming", { partial: true }),
		]);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: "message", message: { id: 1, content: "streaming", partial: true } });
	});

	it("keeps reused tool call ids from separate turns independent", () => {
		const rows = buildConversationRows([
			message(1, "user", "first"),
			message(2, "assistant", "", { toolCalls: [{ id: "reused", name: "shell", argsText: '{"command":"pwd"}' }] }),
			message(3, "toolResult", "A", { toolCallId: "reused", toolName: "shell" }),
			message(4, "user", "second"),
			message(5, "assistant", "", { toolCalls: [{ id: "reused", name: "shell", argsText: '{"command":"id"}' }] }),
			message(6, "toolResult", "B", { toolCallId: "reused", toolName: "shell" }),
		]);
		const tools = rows.filter((row) => row.kind === "tool");
		expect(tools).toHaveLength(2);
		expect(tools.map((row) => (row.kind === "tool" ? row.tool.resultText : ""))).toEqual(["A", "B"]);
	});

	it("splits tagged and native thinking from the visible response", () => {
		expect(splitAssistantContent("<summary>Inspect binary</summary><think>Check symbols</think>Answer")).toEqual({
			summary: "Inspect binary",
			thinking: "Check symbols",
			response: "Answer",
		});
		expect(splitAssistantContent("Answer", "Native reasoning")).toEqual({
			summary: "Native reasoning",
			thinking: "Native reasoning",
			response: "Answer",
		});
	});

	it("normalizes terminal tool states", () => {
		expect(conversationToolStatus("cancelled")).toBe("stopped");
		expect(conversationToolStatus("running", false, "result")).toBe("complete");
		expect(conversationToolStatus("complete", true)).toBe("error");
	});
});
