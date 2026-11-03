import { describe, expect, it, vi } from "vitest";
import { normalizeCompetitionFlag, SlabAgentApi } from "../src/competition-api.ts";

function response(data: unknown): Response {
	return new Response(JSON.stringify({ code: "00000", message: "", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("Slab competition API", () => {
	it("normalizes categorized exercise lists and detail payloads", async () => {
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/ctf/exercise-list")) {
				return response([
					{
						id: 1,
						name: "Web",
						corpus: [{ id: 101, name: "test-web", isOpen: true, hasSolved: false }],
					},
					{
						id: 2,
						name: "Misc",
						corpus: [{ id: 102, name: "already-solved", isOpen: true, hasSolved: true }],
					},
				]);
			}
			return response({
				id: Number(new URL(url).searchParams.get("exerciseId")),
				name: "test-web",
				description: "two official test challenges",
				isOpen: true,
				hasSolved: false,
				isNeedInit: false,
				isNeedCheck: false,
				attachment: { files: [{ name: "challenge.zip", url: "https://example.test/challenge.zip", ext: "zip" }] },
				endpoints: [],
			});
		}) as unknown as typeof fetch;
		const api = new SlabAgentApi({
			baseUrl: "https://gcsis.dasctf.com/1629",
			accessKey: "secret-test-key",
			fetchImpl,
		});

		const summaries = await api.getExerciseList();
		expect(summaries).toEqual([
			expect.objectContaining({ id: 101, name: "test-web", category: "Web" }),
			expect.objectContaining({ id: 102, name: "already-solved", category: "Misc" }),
		]);
		const exercises = await api.syncExercises();
		expect(exercises).toHaveLength(1);
		expect(exercises[0]).toMatchObject({ id: 101, description: "two official test challenges" });
		expect(exercises[0].attachments[0]).toMatchObject({ name: "challenge.zip", ext: "zip" });
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://gcsis.dasctf.com/slab-match/api/v1/agent/ctf/exercise-list",
			expect.objectContaining({
				headers: expect.objectContaining({ "X-Agent-AccessKey": "secret-test-key", matchId: "1629" }),
			}),
		);
	});

	it("recovers an environment after an accepted flag", async () => {
		const calls: string[] = [];
		const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			calls.push(`${init?.method ?? "GET"} ${url}`);
			if (url.endsWith("/answer-panel/answer")) return response({ isCorrect: true });
			if (url.endsWith("/ctf/recover-exercise-env")) return response({ ok: true });
			return response({});
		}) as unknown as typeof fetch;
		const api = new SlabAgentApi({ baseUrl: "https://pro.dasctf.com", accessKey: "secret-test-key", fetchImpl });
		const result = await api.submitFlag(101, "flag{accepted}");
		expect(result.correct).toBe(true);
		expect(calls).toEqual([
			"POST https://pro.dasctf.com/slab-match/api/v1/agent/answer-panel/answer",
			"POST https://pro.dasctf.com/slab-match/api/v1/agent/ctf/recover-exercise-env",
		]);
	});

	it("normalizes the production single-attachment detail shape", async () => {
		const fetchImpl = vi.fn(async () =>
			response({
				id: 103,
				name: "production-shape",
				isOpen: true,
				hasSolved: false,
				isNeedInit: false,
				isNeedCheck: false,
				attachment: {
					name: "challenge.zip",
					url: "https://example.test/production-shape.zip",
					extension: "zip",
				},
				endpoints: [],
			}),
		) as unknown as typeof fetch;
		const api = new SlabAgentApi({ baseUrl: "https://pro.dasctf.com", accessKey: "secret-test-key", fetchImpl });

		const details = await api.getExercise(103);
		expect(details.attachments).toEqual([
			expect.objectContaining({ name: "challenge.zip", url: "https://example.test/production-shape.zip" }),
		]);
	});

	it("limits detail synchronization to five requests per ten-second batch", async () => {
		vi.useFakeTimers();
		try {
			const summaries = Array.from({ length: 6 }, (_, index) => ({
				id: index + 1,
				name: `exercise-${index + 1}`,
				isOpen: true,
				hasSolved: false,
			}));
			const fetchImpl = vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.endsWith("/ctf/exercise-list")) return response(summaries);
				return response({
					id: Number(new URL(url).searchParams.get("exerciseId")),
					name: "exercise",
					description: "test",
					isOpen: true,
					hasSolved: false,
					isNeedInit: false,
					isNeedCheck: false,
					endpoints: [],
				});
			}) as unknown as typeof fetch;
			const api = new SlabAgentApi({
				baseUrl: "https://pro.dasctf.com",
				accessKey: "secret-test-key",
				fetchImpl,
			});

			const sync = api.syncExercises();
			await vi.advanceTimersByTimeAsync(0);
			expect(fetchImpl).toHaveBeenCalledTimes(6); // list + first five details
			await vi.advanceTimersByTimeAsync(9_999);
			expect(fetchImpl).toHaveBeenCalledTimes(6);
			await vi.advanceTimersByTimeAsync(1);
			await sync;
			expect(fetchImpl).toHaveBeenCalledTimes(7);
		} finally {
			vi.useRealTimers();
		}
	});

	it("normalizes wrapper forms before submitting", () => {
		expect(normalizeCompetitionFlag("DASCTF{value}")).toBe("value");
		expect(normalizeCompetitionFlag("flag{value}")).toBe("value");
		expect(normalizeCompetitionFlag("{value}")).toBe("value");
	});
});
