import { expect, it } from "vitest";

it.each([400, 422])("classifies HTTP %s as an invalid request without exporting its body", (status) => {
	expect(modelErrorMetadata(`${status}: {"error":"Invalid schema","api_key":"test-only-secret"}`)).toEqual({
		providerStatus: status,
		errorCategory: "invalid_request",
	});
});

import { sanitizePlanningTracePayload } from "../src/bridge.ts";
import { sanitizeCairnTracePayload } from "../src/planning/cairn/trace.ts";
import { modelErrorMetadata } from "../src/planning/model-error-metadata.ts";

it("preserves quota classification across both Cairn and bridge filters without exporting the body", () => {
	const error =
		'429: {"type":"rate_limit_error","http_code":"429","message":"已达到 Token Plan 用量上限 (2056)","api_key":"test-only-secret"}';
	const payload = { role: "executor", stopReason: "error", ...modelErrorMetadata(error), error };
	const actual = sanitizePlanningTracePayload(
		"cairn_executor_assistant_message_end",
		sanitizeCairnTracePayload(payload),
	);
	expect(actual).toMatchObject({
		errorCategory: "provider_quota_exhausted",
		providerStatus: 429,
		quotaExhausted: true,
	});
	expect(JSON.stringify(actual)).not.toContain("test-only-secret");
	expect(actual).not.toHaveProperty("error");
});

it("distinguishes a generic 429 from quota exhaustion and ignores numeric coincidences", () => {
	expect(modelErrorMetadata('429: {"message":"retry later"}')).toEqual({
		providerStatus: 429,
		errorCategory: "rate_limit_or_unknown",
	});
	expect(modelErrorMetadata("elapsedMs 205622")).toEqual({ errorCategory: "unknown" });
	expect(modelErrorMetadata("terminated")).toEqual({ errorCategory: "transport_or_cancellation_unknown" });
});

it("retains known transport cause and wait duration across both exports", () => {
	const actual = sanitizePlanningTracePayload(
		"model_service_wait_end",
		sanitizeCairnTracePayload({
			...modelErrorMetadata("socket reset ECONNRESET; Bearer test-only-secret"),
			waitElapsedMs: 1644682,
			protocolRecovery: false,
			quotaExhausted: false,
		}),
	);
	expect(actual).toEqual({
		errorCategory: "transport_reset",
		transportCode: "ECONNRESET",
		waitElapsedMs: 1644682,
		protocolRecovery: false,
		quotaExhausted: false,
	});
});
