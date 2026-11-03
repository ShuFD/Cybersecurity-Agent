import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { markModelQuotaUnavailable, modelQuotaUnavailable } from "../src/planning/model-availability.ts";

it("shares a known hard quota only among sessions with the same runtime and provider/model", () => {
	const a = {} as ModelRuntime,
		b = {} as ModelRuntime;
	markModelQuotaUnavailable(a, "provider:model", "recorded hard-quota response");
	expect(modelQuotaUnavailable(a, "provider:model")).toMatchObject({ quotaExhausted: true });
	expect(modelQuotaUnavailable(a, "other:model")).toBeUndefined();
	expect(modelQuotaUnavailable(b, "provider:model")).toBeUndefined();
});
