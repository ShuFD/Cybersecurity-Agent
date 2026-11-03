import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AttachmentCache } from "../src/competition-attachments.ts";
import { CompetitionStore } from "../src/competition-store.ts";

describe("competition attachment cache", () => {
	it("deduplicates concurrent URLs and validates streamed size and hash", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-attachment-cache-"));
		const store = await CompetitionStore.open(join(root, "competition.sqlite"));
		const body = new TextEncoder().encode("evidence archive");
		const sha256 = createHash("sha256").update(body).digest("hex");
		let active = 0;
		let maximumActive = 0;
		const fetchImpl = vi.fn(async () => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active -= 1;
			return new Response(body, { status: 200, headers: { "content-length": String(body.byteLength) } });
		}) as unknown as typeof fetch;
		const cache = new AttachmentCache({
			store,
			cacheRoot: join(root, "cache"),
			fetchImpl,
			maxConcurrent: 2,
			perHostIntervalMs: 0,
		});
		try {
			const ref = {
				name: "challenge.bin",
				url: "https://files.example/challenge.bin",
				sizeBytes: body.byteLength,
				sha256,
			};
			const entries = await Promise.all([cache.download(ref), cache.download(ref)]);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			expect(maximumActive).toBe(1);
			expect(entries[0]?.sha256).toBe(sha256);
			expect(entries[0]?.path).toBe(entries[1]?.path);

			const limited = new AttachmentCache({
				store,
				cacheRoot: join(root, "limited"),
				fetchImpl: vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]))),
				maxBytes: 3,
				retries: 0,
				perHostIntervalMs: 0,
			});
			await expect(limited.download({ name: "too-large", url: "https://files.example/large" })).rejects.toThrowError(
				/size limit/iu,
			);
		} finally {
			store.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
