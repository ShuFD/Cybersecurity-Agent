import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDefaultModelCatalog, ensureEnvironmentAuth } from "../src/model-defaults.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("default Pi model configuration", () => {
	it("seeds the current DeepSeek and GLM providers without credentials", async () => {
		const directory = await mkdtemp(join(tmpdir(), "secheur-model-defaults-"));
		temporaryDirectories.push(directory);
		ensureDefaultModelCatalog(directory);
		const catalog = JSON.parse(await readFile(join(directory, "models.json"), "utf8")) as {
			providers: Record<string, { baseUrl: string; api: string }>;
		};
		expect(catalog.providers["secheur-deepseek"]).toMatchObject({
			baseUrl: "https://api.deepseek.com",
			api: "openai-responses",
		});
		expect(catalog.providers["secheur-glm"]).toMatchObject({
			baseUrl: "https://llm-gateway.dasctf.com/llm-gateway/proxy/e/H5Jx-bqJJQCkbZys",
			api: "openai-responses",
		});
	});

	it("fills missing auth entries without replacing existing credentials", async () => {
		const directory = await mkdtemp(join(tmpdir(), "secheur-model-auth-"));
		temporaryDirectories.push(directory);
		ensureEnvironmentAuth(directory, {
			SECHEUR_DEEPSEEK_API_KEY: "deepseek-test-key",
			SECHEUR_GLM_API_KEY: "glm-test-key",
		});
		expect(JSON.parse(await readFile(join(directory, "auth.json"), "utf8"))).toEqual({
			"secheur-deepseek": { type: "api_key", key: "deepseek-test-key" },
			"secheur-glm": { type: "api_key", key: "glm-test-key" },
		});

		await writeFile(join(directory, "auth.json"), "{}\n");
		ensureEnvironmentAuth(directory, { SECHEUR_DEEPSEEK_API_KEY: "replacement" });
		expect(JSON.parse(await readFile(join(directory, "auth.json"), "utf8"))).toEqual({
			"secheur-deepseek": { type: "api_key", key: "replacement" },
		});

		await writeFile(join(directory, "auth.json"), '{"secheur-deepseek":{"type":"api_key","key":"existing"}}\n');
		ensureEnvironmentAuth(directory, { SECHEUR_DEEPSEEK_API_KEY: "replacement" });
		expect(await readFile(join(directory, "auth.json"), "utf8")).toContain("existing");
	});

	it("migrates the bundled GLM model to its 1M context window", async () => {
		const directory = await mkdtemp(join(tmpdir(), "secheur-model-migration-"));
		temporaryDirectories.push(directory);
		await writeFile(
			join(directory, "models.json"),
			JSON.stringify({ providers: { "secheur-glm": { models: [{ id: "glm-5.3", contextWindow: 200_000 }] } } }),
		);

		ensureDefaultModelCatalog(directory);

		const catalog = JSON.parse(await readFile(join(directory, "models.json"), "utf8")) as {
			providers: { "secheur-glm": { models: Array<{ id: string; contextWindow: number }> } };
		};
		expect(catalog.providers["secheur-glm"].models[0]).toMatchObject({ id: "glm-5.3", contextWindow: 1_000_000 });
	});

	it("migrates the legacy DeepSeek endpoint to the official Responses base URL", async () => {
		const directory = await mkdtemp(join(tmpdir(), "secheur-deepseek-migration-"));
		temporaryDirectories.push(directory);
		await writeFile(
			join(directory, "models.json"),
			JSON.stringify({
				providers: {
					"secheur-deepseek": {
						baseUrl: "https://loliapi.org",
						models: [{ id: "deepseek-v4-flash", baseUrl: "https://loliapi.org" }],
					},
				},
			}),
		);

		ensureDefaultModelCatalog(directory, { SECHEUR_DEEPSEEK_BASE_URL: "https://api.deepseek.com/responses" });

		const catalog = JSON.parse(await readFile(join(directory, "models.json"), "utf8")) as {
			providers: { "secheur-deepseek": { baseUrl: string; models: Array<{ baseUrl: string }> } };
		};
		expect(catalog.providers["secheur-deepseek"]).toMatchObject({
			baseUrl: "https://api.deepseek.com",
			models: [{ baseUrl: "https://api.deepseek.com" }],
		});
	});
});
