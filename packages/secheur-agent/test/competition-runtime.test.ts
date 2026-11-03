import { describe, expect, it } from "vitest";
import {
	competitionAdapterConfigFromEnvironment,
	createCompetitionAdapter,
	resolveCompetitionAdapterConfig,
} from "../src/competition-runtime.ts";
import { loadSecHeurConfig } from "../src/config.ts";

describe("competition adapter runtime configuration", () => {
	it("normalizes a local CTFd endpoint and builds the agent API transport", () => {
		const env = {
			CTFD_URL: "127.0.0.1:18000",
			CTFD_AGENT_ACCESS_KEY: "runtime-access-key",
		};
		const config = competitionAdapterConfigFromEnvironment(env);
		const built = createCompetitionAdapter(config, {
			config: loadSecHeurConfig({ projectRoot: process.cwd(), env }),
			env,
			maxEnvironmentSlots: 3,
		});

		expect(config).toMatchObject({
			platform: "ctfd",
			transport: "agent_api",
			baseUrl: "http://127.0.0.1:18000",
		});
		expect(built.summary).toMatchObject({
			platform: "ctfd",
			transport: "agent_api",
			baseUrl: "http://127.0.0.1:18000",
			agentApiUrl: "http://127.0.0.1:18000/slab-match/api/v1/agent",
			credentials: { accessKeyConfigured: true, apiTokenConfigured: false },
		});
		expect(JSON.stringify(built.summary)).not.toContain("runtime-access-key");
	});

	it("switches transports without retaining an active access key in the summary", () => {
		const env = {
			CTFD_AGENT_ACCESS_KEY: "env-access-key",
			CTFD_API_TOKEN: "env-api-token",
		};
		const current = competitionAdapterConfigFromEnvironment({
			...env,
			CTFD_URL: "http://old-ctfd.test",
		});
		const next = resolveCompetitionAdapterConfig(
			{
				baseUrl: "127.0.0.1:18000",
				transport: "ctfd_api",
				useEnvironmentCredentials: true,
			},
			current,
			env,
		);

		expect(next).toMatchObject({ platform: "ctfd", transport: "ctfd_api", baseUrl: "http://127.0.0.1:18000" });
		expect(next.accessKey).toBe("env-access-key");
		expect(next.apiToken).toBe("env-api-token");
	});

	it("rejects unapproved credential environment variables and embedded URL credentials", () => {
		const current = competitionAdapterConfigFromEnvironment({ CTFD_URL: "http://ctfd.test" });
		expect(() => resolveCompetitionAdapterConfig({ accessKeyEnv: "PATH" }, current, { PATH: "/bin" })).toThrow(
			/approved credential environment variable/iu,
		);
		expect(() => resolveCompetitionAdapterConfig({ baseUrl: "http://user:password@ctfd.test" }, current, {})).toThrow(
			/embedded credentials/iu,
		);
	});
});
