import { expect, it } from "vitest";
import { sanitizePlanningTracePayload } from "../src/bridge.ts";

it("preserves planner tool identity while excluding arguments and raw results", () => {
	const value = sanitizePlanningTracePayload("tool_execution_start", {
		role: "planner",
		requestId: "request-1",
		toolCallId: "call-1",
		toolName: "planning_query_context",
		elapsedMs: 258100,
		args: { secret: "private" },
		result: "raw observation",
	});
	expect(value).toEqual({
		role: "planner",
		requestId: "request-1",
		toolCallId: "call-1",
		toolName: "planning_query_context",
		elapsedMs: 258100,
	});
});
it("persists a bounded redacted rejection reason and service wait metadata", () => {
	expect(
		sanitizePlanningTracePayload("planning_submission_rejected", {
			role: "planner",
			requestId: "request-2",
			error: "invalid reference; api_key=private-value",
			rejections: 1,
		}),
	).toMatchObject({ requestId: "request-2", error: 'invalid reference; api_key="[REDACTED]"', rejections: 1 });
	expect(
		sanitizePlanningTracePayload("model_service_wait_end", {
			role: "executor",
			reason: "provider_quota_exhausted",
			waitElapsedMs: 2518688,
			quotaExhausted: true,
			protocolRecovery: false,
		}),
	).toMatchObject({ waitElapsedMs: 2518688, quotaExhausted: true, protocolRecovery: false });
});
