import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BigModelRunner } from "../src/bigmodel-runner.ts";

describe("BigModel 10756 runner", () => {
	it("uses Bearer auth while keeping the key out of audit output", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-bigmodel-"));
		const workdir = join(root, "10756");
		await mkdir(workdir, { recursive: true });
		await writeFile(join(workdir, "notes.txt"), "local fixture");
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						output: [
							{
								type: "function_call",
								name: "read_file",
								call_id: "call-1",
								arguments: JSON.stringify({ path: "notes.txt" }),
							},
						],
					}),
				),
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ output_text: "verified" })));
		try {
			const runner = new BigModelRunner({
				workdir,
				env: { BIGMODEL_API_KEY: "secret-key-for-test" },
				fetchImpl: fetchImpl as unknown as typeof fetch,
				model: "glm-5.3-test",
				auditPath: join(workdir, "audit.jsonl"),
			});
			const result = await runner.run("Inspect the fixture.");
			expect(result.text).toBe("verified");
			expect(result.toolCalls[0]?.name).toBe("read_file");
			expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://open.bigmodel.cn/api/v1/responses");
			expect(fetchImpl).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					headers: expect.objectContaining({ Authorization: "Bearer secret-key-for-test" }),
				}),
			);
			const audit = await readFile(join(workdir, "audit.jsonl"), "utf8");
			expect(audit).not.toContain("secret-key-for-test");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects paths outside the 10756 workdir", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-bigmodel-path-"));
		const workdir = join(root, "10756");
		await mkdir(workdir, { recursive: true });
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						output: [
							{
								type: "function_call",
								name: "read_file",
								call_id: "call-escape",
								arguments: JSON.stringify({ path: "../outside" }),
							},
						],
					}),
				),
		) as unknown as typeof fetch;
		try {
			const runner = new BigModelRunner({ workdir, env: { BIGMODEL_API_KEY: "test" }, fetchImpl, maxTurns: 1 });
			await expect(runner.run("escape")).rejects.toThrowError(/escapes the challenge workdir/iu);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
