import { describe, expect, it, vi } from "vitest";
import { normalizeOsvTarget, OsvClient, OsvInputError } from "../src/osv.ts";

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const packageTarget = {
	packageName: "demo-package",
	ecosystem: "npm",
	version: "1.2.3",
	evidenceRefs: ["package-lock.json:42"],
};

describe("OSV client", () => {
	it("normalizes exact package, versioned PURL, and full commit evidence", () => {
		expect(normalizeOsvTarget(packageTarget)).toMatchObject({
			query: { package: { name: "demo-package", ecosystem: "npm" }, version: "1.2.3" },
			queryKind: "package",
			identity: "package:npm:demo-package@1.2.3",
		});
		expect(
			normalizeOsvTarget({ purl: "pkg:npm/demo-package@1.2.3", evidenceRefs: ["manifest.json:8"] }),
		).toMatchObject({ query: { package: { purl: "pkg:npm/demo-package@1.2.3" } }, queryKind: "purl" });
		expect(
			normalizeOsvTarget({
				commit: "0123456789abcdef0123456789abcdef01234567",
				evidenceRefs: ["git rev-parse HEAD"],
			}),
		).toMatchObject({ query: { commit: "0123456789abcdef0123456789abcdef01234567" }, queryKind: "commit" });
	});

	it("rejects missing exact version evidence and mixed selectors", () => {
		expect(() => normalizeOsvTarget({ packageName: "demo", ecosystem: "npm", evidenceRefs: ["manifest"] })).toThrow(
			OsvInputError,
		);
		expect(() => normalizeOsvTarget({ purl: "pkg:npm/demo", evidenceRefs: ["manifest"] })).toThrow(OsvInputError);
		expect(() =>
			normalizeOsvTarget({
				packageName: "demo",
				ecosystem: "npm",
				version: "1.0.0",
				purl: "pkg:npm/demo@1.0.0",
				evidenceRefs: ["manifest"],
			}),
		).toThrow(OsvInputError);
		expect(() => normalizeOsvTarget({ commit: "0123", evidenceRefs: ["git"] })).toThrow(OsvInputError);
	});

	it("uses querybatch, preserves target ordering, and summarizes fixed versions", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.endsWith("/v1/querybatch"))
				return jsonResponse({
					results: [{ vulns: [{ id: "GHSA-demo-1234", modified: "2026-08-30T00:00:00Z" }] }, { vulns: [] }],
				});
			if (url.endsWith("/v1/vulns/GHSA-demo-1234"))
				return jsonResponse({
					id: "GHSA-demo-1234",
					summary: "Demo vulnerability",
					modified: "2026-08-30T00:00:00Z",
					database_specific: { severity: "HIGH" },
					affected: [
						{
							package: { name: "demo-package", ecosystem: "npm" },
							ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.2.4" }] }],
							versions: ["1.0.0", "1.2.3"],
						},
					],
					references: [{ type: "ADVISORY", url: "https://example.test/advisory" }],
				});
			throw new Error(`unexpected URL ${url}`);
		}) as unknown as typeof fetch;
		const client = new OsvClient({ apiUrl: "https://osv.test", fetchImpl, cacheTtlMs: 0 });
		const result = await client.query([packageTarget, { ...packageTarget, version: "2.0.0" }]);

		expect(result).toMatchObject({ status: "ok", queryCount: 2, vulnerabilityCount: 1, truncated: false });
		expect(result.results).toHaveLength(2);
		expect(result.results[0]).toMatchObject({
			identity: "package:npm:demo-package@1.2.3",
			status: "matched",
			vulnerabilities: [
				expect.objectContaining({
					id: "GHSA-demo-1234",
					severity: ["HIGH"],
					affected: [expect.objectContaining({ fixedVersions: ["1.2.4"] })],
				}),
			],
		});
		expect(result.results[1]).toMatchObject({ identity: "package:npm:demo-package@2.0.0", status: "none" });
		expect(calls[0]?.url).toBe("https://osv.test/v1/querybatch");
		expect(calls[0]?.init?.method).toBe("POST");
		expect(calls[0]?.init?.headers).toEqual({ accept: "application/json", "content-type": "application/json" });
		expect(calls[0]?.init?.body).toContain('"queries"');
		expect(calls[0]?.init?.body).not.toContain("authorization");
	});

	it("follows a bounded querybatch page and caches identical queries", async () => {
		let querybatchCalls = 0;
		const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/v1/querybatch")) {
				querybatchCalls += 1;
				const body = JSON.parse(String(init?.body)) as { queries: Array<{ page_token?: string }> };
				return body.queries[0]?.page_token
					? jsonResponse({ results: [{ vulns: [{ id: "OSV-page-2", modified: "later" }] }] })
					: jsonResponse({
							results: [{ vulns: [{ id: "OSV-page-1", modified: "now" }], next_page_token: "next" }],
						});
			}
			if (url.includes("OSV-page-")) return jsonResponse({ id: url.split("/").at(-1), summary: "paged" });
			throw new Error(`unexpected URL ${url}`);
		}) as unknown as typeof fetch;
		const client = new OsvClient({ apiUrl: "https://osv.test", fetchImpl, cacheTtlMs: 60_000 });
		const first = await client.query([packageTarget]);
		const second = await client.query([packageTarget]);

		expect(first.vulnerabilityCount).toBe(2);
		expect(first.results[0]?.vulnerabilities.map((item) => item.id)).toEqual(["OSV-page-1", "OSV-page-2"]);
		expect(second).toEqual(first);
		expect(querybatchCalls).toBe(2);
	});

	it("returns a bounded unavailable result after transient API failure", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ error: "busy" }, 503)) as unknown as typeof fetch;
		const client = new OsvClient({ apiUrl: "https://osv.test", fetchImpl, cacheTtlMs: 0 });
		const result = await client.query([packageTarget]);

		expect(result.status).toBe("unavailable");
		expect(result.results[0]).toMatchObject({ status: "unavailable", vulnerabilities: [] });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
});
