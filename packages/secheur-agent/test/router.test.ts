import type { Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveBigModelRoute } from "../src/bigmodel-config.ts";
import {
	chooseSecHeurRouterTier,
	defaultSecHeurRouterConfig,
	loadSecHeurRouterConfig,
	selectSecHeurRouterTier,
} from "../src/router.ts";

function context(prompt: string): Context {
	return { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] };
}

describe("SecHeur model router", () => {
	it("uses the official high-tier fallback policy", () => {
		const config = defaultSecHeurRouterConfig();
		expect(config.profiles.auto.high).toEqual({
			model: "secheur-glm/glm-5.3",
			thinking: "max",
			fallbacks: ["secheur-deepseek/deepseek-v4-flash"],
		});
		expect(config.profiles.auto.medium.model).toBe("secheur-deepseek/deepseek-v4-flash");
		expect(config.profiles.auto.low.thinking).toBe("max");
	});

	it("routes CTF analysis high and ordinary implementation medium/low", () => {
		const config = defaultSecHeurRouterConfig();
		expect(chooseSecHeurRouterTier(context("analyze the pwn exploit and recover the flag"), config)).toBe("high");
		expect(chooseSecHeurRouterTier(context("implement the parser and add tests"), config)).toBe("medium");
		expect(chooseSecHeurRouterTier(context("status?"), config)).toBe("low");
	});

	it.each(["analyze the pwn exploit and recover the flag", "CTF challenge 尚未通过可信 verifier...", "continue"])(
		"keeps a CTF session on the high tier after follow-up text: %s",
		(prompt) => {
			const config = defaultSecHeurRouterConfig();
			expect(selectSecHeurRouterTier(context(prompt), config, "ctf")).toBe("high");
		},
	);

	it("preserves dynamic routing for non-CTF sessions", () => {
		const config = defaultSecHeurRouterConfig();
		for (const prompt of ["implement the parser and add tests", "status?"]) {
			expect(selectSecHeurRouterTier(context(prompt), config, "chat")).toBe(
				chooseSecHeurRouterTier(context(prompt), config),
			);
		}
	});

	it("falls back to built-in policy when a project router file is malformed", () => {
		const config = loadSecHeurRouterConfig("/path/that/does/not/exist");
		expect(config.profiles.auto.high.model).toBe("secheur-glm/glm-5.3");
	});

	it("normalizes the full BigModel Responses endpoint for the GLM route", () => {
		expect(
			resolveBigModelRoute({
				BIGMODEL_API_KEY: "test-key",
				BIGMODEL_RESPONSES_ENDPOINT: "https://open.bigmodel.cn/api/v1/responses/",
				BIGMODEL_MODEL: "glm-5.3",
			}),
		).toEqual({
			apiKey: "test-key",
			baseUrl: "https://open.bigmodel.cn/api/v1",
			model: "glm-5.3",
		});
		expect(resolveBigModelRoute({})).toBeUndefined();
	});
});
