import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CairnHostEvidence } from "../src/planning/cairn/host-evidence.ts";
import { sanitizeCairnTracePayload } from "../src/planning/cairn/trace.ts";
import type { IntentLease } from "../src/planning/cairn/types.ts";

function lease(intentId = "intent-a", challengeId = "run-a"): IntentLease {
	return {
		challengeId,
		intentId,
		solverId: "solver",
		generation: 1,
		version: 1,
		token: "fixture-only",
		leaseUntil: new Date().toISOString(),
	};
}
const execution = {
	toolCallId: "call-1",
	toolName: "local_fixture",
	isError: false,
	result: { content: [{ type: "text", text: "full local observation" }] },
};
describe("Cairn host evidence persistence", () => {
	it("uses run and Intent scope even when a reused Solver repeats a tool call ID", () => {
		const root = mkdtempSync(join(tmpdir(), "cairn-evidence-"));
		const host = new CairnHostEvidence(join(root, "host.sqlite"));
		try {
			const a = host.save(lease(), execution);
			expect(host.save(lease(), execution)).toEqual(a);
			const b = host.save(lease("intent-b"), execution);
			expect(b.evidenceId).not.toBe(a.evidenceId);
			const other = host.save(lease("intent-a", "run-b"), execution);
			expect(other.evidenceId).not.toBe(a.evidenceId);
			expect(host.read("run-b", a.evidenceId)).toBeUndefined();
			expect(() => host.save(lease(), { ...execution, result: { content: [] } })).toThrow("Conflicting tool result");
		} finally {
			host.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("paginates append-only evidence without skipping or duplicating entries and reopens durable content", () => {
		const root = mkdtempSync(join(tmpdir(), "cairn-evidence-pages-"));
		const path = join(root, "host.sqlite");
		let host = new CairnHostEvidence(path);
		try {
			const a = host.save(lease(), execution);
			host.save(lease(), { ...execution, toolCallId: "call-2" });
			const first = host.list("run-a", 0, 1);
			expect(first.hasMore).toBe(true);
			expect(first.items).toHaveLength(1);
			host.save(lease(), { ...execution, toolCallId: "call-3" });
			const next = host.list("run-a", first.nextCursor, 2);
			expect(next.hasMore).toBe(false);
			expect(next.items).toHaveLength(2);
			expect(host.list("run-b").items).toHaveLength(0);
			expect(() => host.list("run-a", -1)).toThrow("cursor/limit");
			host.close();
			host = new CairnHostEvidence(path);
			expect(host.read("run-a", a.evidenceId)).toEqual(a);
		} finally {
			host.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("keeps raw content out of exported orchestration metadata", () => {
		const root = mkdtempSync(join(tmpdir(), "cairn-trace-"));
		const host = new CairnHostEvidence(join(root, "host.sqlite"));
		try {
			host.event("run-a", "cairn_executor_start", {
				taskId: "intent-a",
				solverId: "solver",
				content: "raw observation",
				elapsedMs: 5,
			});
			const event = host.events("run-a").events[0];
			expect(sanitizeCairnTracePayload(event.payload)).toEqual({
				engine: "cairn",
				runId: "run-a",
				taskId: "intent-a",
				solverId: "solver",
				elapsedMs: 5,
			});
			expect(host.eventsCount("run-a")).toBe(1);
			expect(host.events("run-a", event.sequence).events).toHaveLength(0);
		} finally {
			host.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
