import { describe, expect, it, vi } from "vitest";
import {
	CompetitionPlatformError,
	type CompetitionPolicy,
	CtfLabAdapter,
	flagFormatFromRaw,
} from "../src/competition-adapters.ts";

function response(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify({ data }), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

describe("CTFd and local lab adapter", () => {
	it("maps CTFd challenge data and keeps the bearer credential on broker requests", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.endsWith("/api/v1/configs"))
				return response({
					max_attempts: 2,
					flag_format: { prefix: "", suffix: "", accepts: "full", submit: "full" },
				});
			if (url.endsWith("/api/v1/challenges"))
				return response([
					{
						id: 7,
						name: "local-pwn",
						category: "pwn",
						value: 500,
						solved_by_me: false,
						view: "<div x-show=\"response.data.status == 'correct'\">browser-only template</div>",
					},
				]);
			if (url.endsWith("/api/v1/challenges/7"))
				return response({
					id: 7,
					name: "local-pwn",
					category: "pwn",
					type: "standard",
					description: "A local challenge",
					hints: ["Use the supplied libc"],
					files: [{ name: "attach.zip", url: "https://ctf.test/attach.zip", sha256: "abc" }, "/files/payload.bin"],
					value: 500,
					connection_info: "tcp://127.0.0.1:31337",
					view: "<div x-show=\"response.data.status == 'correct'\">browser-only template</div>",
					solves: [{ name: "operator" }],
				});
			if (url.endsWith("/v1/environments") && init?.method === "POST")
				return response({ status: "ready", endpoints: ["tcp://127.0.0.1:31337"], lease_id: "lease-7" });
			if (url.endsWith("/v1/environments/7/heartbeat") && init?.method === "POST")
				return response({ status: "ready", endpoints: ["tcp://127.0.0.1:31337"] });
			if (url.endsWith("/v1/environments/7") && init?.method === "DELETE") return response({ released: true });
			if (url.endsWith("/v1/environments/7"))
				return response({ status: "ready", endpoints: ["tcp://127.0.0.1:31337"] });
			if (url.endsWith("/api/v1/challenges/attempt")) return response({ status: "correct", code: "accepted" });
			throw new Error(`unexpected request: ${url}`);
		}) as unknown as typeof fetch;
		const adapter = new CtfLabAdapter({
			baseUrl: "http://ctfd.test",
			token: "broker-secret",
			environmentGatewayUrl: "http://gateway.test",
			fetchImpl,
		});

		const policy = await adapter.getPolicy();
		expect(policy.submission.maxAttempts).toBe(2);
		expect(policy.flagFormat.submit).toBe("full");
		const summaries = await adapter.listChallenges();
		expect(summaries).toEqual([expect.objectContaining({ exerciseId: 7, name: "local-pwn", score: 500 })]);
		expect(summaries[0]?.raw).not.toHaveProperty("view");
		const challenge = await adapter.getChallenge(7);
		expect(challenge).toMatchObject({
			exerciseId: 7,
			attachments: [
				{ name: "attach.zip", sha256: "abc" },
				{ name: "payload.bin", url: "http://ctfd.test/files/payload.bin" },
			],
			environment: { required: true, status: "pending" },
		});
		expect(challenge.platform).toMatchObject({
			id: 7,
			name: "local-pwn",
			category: "pwn",
			type: "standard",
			value: 500,
		});
		expect(challenge.platform).not.toHaveProperty("view");
		expect(challenge.platform).not.toHaveProperty("solves");
		expect(JSON.stringify(challenge.platform)).not.toContain("x-show");
		expect(await adapter.startEnvironment(7)).toMatchObject({
			status: "ready",
			endpoints: ["tcp://127.0.0.1:31337"],
		});
		expect(await adapter.getEnvironment(7)).toMatchObject({ status: "ready" });
		expect(await adapter.heartbeatEnvironment!(7)).toMatchObject({ status: "ready" });
		const submitted = await adapter.submitFlag(7, "FLAG{local}", {
			taskId: "ctfd:7",
			attemptNo: 1,
			policy,
		});
		expect(submitted).toMatchObject({ isCorrect: true, businessCode: "accepted" });
		expect(await adapter.releaseEnvironment(7)).toEqual({ released: true });

		const ctfdCall = calls.find((call) => call.url.endsWith("/api/v1/challenges/attempt"));
		expect(ctfdCall?.init?.headers).toEqual(
			expect.objectContaining({ Authorization: "Token broker-secret", "Content-Type": "application/json" }),
		);
		expect(JSON.parse(String(ctfdCall?.init?.body))).toEqual({ challenge_id: 7, submission: "FLAG{local}" });
		const gatewayCall = calls.find((call) => call.url.endsWith("/v1/environments"));
		expect(gatewayCall?.init?.headers).not.toHaveProperty("Authorization");
	});

	it("classifies gateway quota failures without exposing them as solver failures", async () => {
		const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input).endsWith("/v1/environments") && init?.method === "POST")
				return response({ message: "environment quota exhausted" }, 550, { "retry-after": "4" });
			return response({});
		}) as unknown as typeof fetch;
		const adapter = new CtfLabAdapter({
			baseUrl: "http://ctfd.test",
			token: "token",
			environmentGatewayUrl: "http://gateway.test",
			fetchImpl,
		});

		await expect(adapter.startEnvironment(10756)).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(CompetitionPlatformError);
			const platformError = error as CompetitionPlatformError;
			expect(platformError.category).toBe("environment_error");
			expect(platformError.httpStatus).toBe(550);
			expect(platformError.retryAfterMs).toBe(4_000);
			return true;
		});
	});

	it("keeps raw flag-format policy fields explicit", () => {
		const fallback: CompetitionPolicy["flagFormat"] = {
			prefix: "",
			suffix: "",
			accepts: "either",
			submit: "full",
		};
		expect(flagFormatFromRaw({ flag_prefix: "CTF{", flag_suffix: "}" }, fallback)).toEqual({
			prefix: "CTF{",
			suffix: "}",
			accepts: "either",
			submit: "full",
		});
		expect(
			flagFormatFromRaw({ flag_prefix: "", flag_suffix: "" }, { ...fallback, prefix: "DASCTF{", suffix: "}" }),
		).toEqual({
			prefix: "",
			suffix: "",
			accepts: "either",
			submit: "full",
		});
	});
});
