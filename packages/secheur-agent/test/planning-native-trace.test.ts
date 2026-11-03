import { expect, it } from "vitest";
import { sanitizePlanningTracePayload } from "../src/bridge.ts";
import { sanitizeCairnTracePayload } from "../src/planning/cairn/trace.ts";

it("preserves native planning identity and timing without leaking arguments or model text", () => {
	const payload = {
		runId: "run",
		requestId: "req",
		role: "planner",
		toolCallId: "call",
		toolName: "planning_read_evidence",
		elapsedMs: 32,
		isError: false,
		origin: "model",
		args: { secret: "hidden" },
		content: "hidden",
	};
	expect(sanitizePlanningTracePayload("tool_execution_start", payload)).toEqual({
		runId: "run",
		requestId: "req",
		role: "planner",
		toolCallId: "call",
		toolName: "planning_read_evidence",
		elapsedMs: 32,
		isError: false,
		origin: "model",
	});
	expect(sanitizeCairnTracePayload(payload)).not.toHaveProperty("args");
});
