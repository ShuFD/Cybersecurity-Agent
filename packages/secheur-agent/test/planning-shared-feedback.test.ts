import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CairnHostEvidence } from "../src/planning/cairn/host-evidence.ts";
import type { IntentLease } from "../src/planning/cairn/types.ts";
import type { EvidenceCard } from "../src/planning/evidence-cards.ts";
import {
	boundedVerificationHistory,
	renderSharedTaskProgress,
	renderSharedVerificationHistory,
} from "../src/planning/shared-feedback.ts";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "shared-feedback-"));
	roots.push(root);
	return join(root, "host.sqlite");
}
function lease(intentId: string, challengeId = "fixture-run"): IntentLease {
	return {
		challengeId,
		intentId,
		solverId: "solver-" + intentId,
		generation: 1,
		version: 1,
		token: "fixture",
		leaseUntil: new Date().toISOString(),
	};
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shared PLAN continuation from durable evidence", () => {
	it("does not let repeated blocked requests evict an actual incorrect verdict", () => {
		const history = [
			{ evidenceId: "actual-verdict", status: "incorrect", requestSent: true },
			...Array.from({ length: 24 }, (_, i) => ({
				evidenceId: `blocked-${i}`,
				status: "duplicate",
				requestSent: false,
			})),
		];
		const retained = boundedVerificationHistory(history);
		expect(retained[0]?.evidenceId).toBe("actual-verdict");
		expect(retained).toHaveLength(17);
		expect(retained.at(-1)?.evidenceId).toBe("blocked-23");
	});
	it("retains exact verifier outcomes, owners and allowance across executors and restart", () => {
		const path = fixture();
		let host = new CairnHostEvidence(path);
		try {
			for (const [index, status] of [
				"incorrect",
				"fresh_evidence_required",
				"duplicate",
				"request_error",
			].entries()) {
				host.save(lease(index % 2 ? "b" : "a"), {
					toolCallId: "verify-" + index,
					toolName: "verify_flag",
					toolInput: { flag: "synthetic-private-candidate" },
					isError: false,
					result: {
						details: {
							data: {
								status,
								verificationOutcome: status === "incorrect" ? "incorrect" : "blocked",
								requestSent: status === "incorrect",
							},
							remainingAttempts: 2,
						},
					},
				});
			}
			const before = host.verificationHistory("fixture-run");
			expect(before.map((entry) => entry.status)).toEqual([
				"incorrect",
				"fresh_evidence_required",
				"duplicate",
				"request_error",
			]);
			expect(before[1]).toMatchObject({
				taskId: "b",
				leaseId: "solver-b:1",
				requestSent: false,
				remainingAttempts: 2,
			});
			expect(host.verificationHistory("other-run")).toEqual([]);
			const rendered = renderSharedVerificationHistory(before);
			expect(rendered).not.toContain("synthetic-private-candidate");
			expect(rendered).not.toContain("candidateHash");
			for (const entry of before) expect(host.read("fixture-run", entry.evidenceId)).toBeDefined();
			host.close();
			host = new CairnHostEvidence(path);
			expect(host.verificationHistory("fixture-run")).toEqual(before);
		} finally {
			host.close();
		}
	});
	it("keeps the latest progress of both tasks after the transcript is absent and new tasks arrive", () => {
		const path = fixture();
		let host = new CairnHostEvidence(path);
		try {
			for (const [index, [task, note]] of [
				["a", "old-a"],
				["b", "latest-b"],
				["a", "latest-a"],
			].entries())
				host.save(lease(task), {
					toolCallId: "checkpoint-" + index,
					toolName: "update_working_checkpoint",
					toolInput: { completed: note, rejected: ["fixture direction"], next: "fixture next step" },
					isError: false,
					result: { saved: true },
				});
			const cards = host.cards("fixture-run");
			let text = renderSharedTaskProgress(cards, "a");
			expect(text).toContain("latest-a");
			expect(text).toContain("latest-b");
			expect(text).not.toContain("old-a");
			expect(text).toContain("not verified facts");
			host.close();
			host = new CairnHostEvidence(path);
			expect(renderSharedTaskProgress(host.cards("fixture-run"), "a")).toBe(text);
			const many = Array.from(
				{ length: 35 },
				(_, i): EvidenceCard => ({
					...cards[0]!,
					id: "new-" + i,
					sourceTaskId: "new-task-" + i,
					summary: "new report " + "字".repeat(590),
				}),
			);
			text = renderSharedTaskProgress([...cards, ...many], "a", 1024);
			expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(1024);
			expect(text).toContain("latest-a");
			expect(text).toContain("omittedTasks");
			expect(host.proof("fixture-run")).toBeUndefined();
		} finally {
			host.close();
		}
	});
});
