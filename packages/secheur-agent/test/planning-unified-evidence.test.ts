import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CairnHostEvidence } from "../src/planning/cairn/host-evidence.ts";
import type { IntentLease } from "../src/planning/cairn/types.ts";
import {
	type EvidenceCardInput,
	evidenceBoardView,
	PlanningEvidenceRepository,
} from "../src/planning/evidence-cards.ts";
import { MAX_EVIDENCE_BLOB_BYTES, readCompleteEvidenceBlob } from "../src/planning/evidence-store.ts";
import { applyHypothesisObservation, emptyHypothesisGraph } from "../src/planning/hypothesis-graph.ts";
import { PlanningStore } from "../src/planning/store.ts";
import { captureToolEvidence } from "../src/planning/tool-evidence.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});
function temp() {
	const root = mkdtempSync(join(tmpdir(), "shared-evidence-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	return root;
}
function intent(challengeId = "run"): IntentLease {
	return {
		challengeId,
		intentId: "task",
		solverId: "solver",
		generation: 1,
		version: 1,
		token: "fixture",
		leaseUntil: new Date().toISOString(),
	};
}
const execution = {
	toolCallId: "call",
	toolName: "fixture",
	toolInput: { path: "sample.txt" },
	isError: false,
	result: { content: [{ type: "text", text: "观察😀".repeat(20_000) }] },
};
const card = (refs: string[], summary = "short supported finding"): EvidenceCardInput => ({
	summary,
	keyValues: { count: 68 },
	scope: "local fixture",
	limitations: "not whole-goal verification",
	evidenceRefs: refs,
	basis: "observed",
});
async function planning(root: string, runId = "run") {
	const store = await PlanningStore.open(join(root, "planning.sqlite"));
	cleanup.push(() => store.close());
	store.createRun({ runId, outerTaskId: runId, goal: "fixture", mode: "active" });
	store.commitPlan({
		runId,
		expectedRevision: 0,
		rationale: "fixture",
		idempotencyKey: "plan",
		tasks: [
			{ taskId: "task", objective: "fixture", doneWhen: "delivery", priority: 0, sequence: 0, dependsOnTaskIds: [] },
		],
	});
	const lease = store.leaseTask(runId, "task", ".", 60_000);
	return { store, lease };
}

describe("shared evidence foundation", () => {
	it("publishes the same fact after a Cairn solver is reused for another intent, including after reopen", () => {
		const path = join(temp(), "host.sqlite");
		let host = new CairnHostEvidence(path);
		const firstLease = intent();
		const secondLease = { ...firstLease, intentId: "next-task" };
		const saved = host.save(firstLease, execution);
		const fact = { id: "fact", statement: "Shared observed result", evidenceRefs: [saved.evidenceId] };
		host.publishFactCard(firstLease, fact);
		host.publishFactCard(secondLease, fact);
		host.publishFactCard(secondLease, fact);
		const before = host.cards("run");
		expect(before).toHaveLength(2);
		expect(new Set(before.map((item) => item.id)).size).toBe(2);
		expect(before.map((item) => item.sourceTaskId)).toEqual(["task", "next-task"]);
		expect(before.map((item) => item.sourceLeaseId)).toEqual(["solver:1", "solver:1"]);
		expect(before[1].sourceHashes).toEqual(before[0].sourceHashes);
		host.close();
		host = new CairnHostEvidence(path);
		cleanup.push(() => host.close());
		host.publishFactCard(firstLease, fact);
		host.publishFactCard(secondLease, fact);
		expect(host.cards("run")).toEqual(before);
	});
	it("keeps existing card IDs and rejects changed source hashes for the same owner", () => {
		const db = new DatabaseSync(":memory:");
		cleanup.push(() => db.close());
		const repo = new PlanningEvidenceRepository(db);
		const owner = { runId: "run", taskId: "task", leaseId: "lease" };
		repo.insert(owner, { kind: "tool", source: "fixture", summary: "raw", contentHash: "original" }, "ev", 1);
		const input = card(["ev"]);
		const first = repo.publish(owner, input);
		expect(first.id).toBe(
			`card_${createHash("sha256")
				.update(`${owner.leaseId}\0${JSON.stringify(input)}`)
				.digest("hex")
				.slice(0, 24)}`,
		);
		db.prepare("UPDATE planning_evidence SET content_hash=? WHERE evidence_id=?").run("changed", "ev");
		expect(() => repo.publish(owner, input)).toThrow("Conflicting evidence card identity");
		expect(repo.allCards("run")).toEqual([first]);
	});
	it("preserves large valid delivery reference sets without adding a card-size rejection", () => {
		const db = new DatabaseSync(":memory:");
		cleanup.push(() => db.close());
		const repo = new PlanningEvidenceRepository(db);
		const owner = { runId: "run", taskId: "task", leaseId: "lease" };
		const refs = Array.from({ length: 100 }, (_, index) => `${index}-`.padEnd(256, "x"));
		for (const id of refs)
			repo.insert(
				owner,
				{ kind: "tool", source: "fixture", summary: "raw", contentHash: "fixture", metadata: {} },
				id,
				1,
			);
		const cards = repo.publishDelivery(owner, {
			summary: "long supported report".repeat(100),
			evidenceRefs: refs,
			scope: "task delivery",
		});
		expect(cards).toHaveLength(4);
		expect(cards.flatMap((card) => card.evidenceRefs)).toEqual(refs);
		expect(cards.every((card) => card.keyValues.deliveryDetailOmitted === true)).toBe(true);
	});
	it("uses the existing blob format for Progressive and Cairn, preserving Unicode, input and error metadata", async () => {
		const root = temp();
		const { store, lease } = await planning(root);
		const raw = captureToolEvidence(execution, { stateDir: root, runId: "run", leaseId: lease.leaseId });
		store.recordEvidence(lease.leaseId, [raw]);
		const host = new CairnHostEvidence(join(root, "host.sqlite"));
		cleanup.push(() => host.close());
		const saved = host.save(intent(), execution);
		expect(JSON.parse(saved.content)).toEqual(execution.result);
		expect(saved.toolInput).toEqual(execution.toolInput);
		const db = new DatabaseSync(join(root, "host.sqlite"));
		cleanup.push(() => db.close());
		expect(db.prepare("SELECT COUNT(*) AS n FROM tool_evidence").get()?.n).toBe(0);
		const row = db.prepare("SELECT * FROM planning_evidence").get()!;
		expect(String(row.content_ref)).toMatch(/^planning-evidence\/blobs\/sha256\//);
		expect(String(row.content_hash)).toBe(saved.contentHash);
		expect(store.snapshot("run").evidence[0].metadata.resultHash).toBe(
			JSON.parse(String(row.metadata_json)).resultHash,
		);
		expect(host.save(intent(), execution)).toEqual(saved);
	});
	it("publishes supported cards without a hypothesis binding and accepts short/long summaries", async () => {
		const root = temp();
		const { store, lease } = await planning(root);
		const raw = captureToolEvidence(execution, { stateDir: root, runId: "run", leaseId: lease.leaseId });
		store.recordEvidence(lease.leaseId, [raw]);
		const first = store.publishEvidenceCard(lease.leaseId, card([raw.evidenceId!]));
		expect(store.publishEvidenceCard(lease.leaseId, card([raw.evidenceId!]))).toEqual(first);
		expect(
			store.publishEvidenceCard(lease.leaseId, card([raw.evidenceId!], "详细发现".repeat(30))).summary,
		).toHaveLength(120);
		expect(store.snapshot("run").evidenceCards).toHaveLength(2);
		expect(store.snapshot("run").hypothesisGraph).toBeUndefined();
		expect(() => store.publishEvidenceCard(lease.leaseId, card(["missing"]))).toThrow("same-run");
		expect(() => store.publishEvidenceCard(lease.leaseId, card([raw.evidenceId!], " "))).toThrow("summary");
	});
	it("keeps hypothesis verdicts separate from common publication and retains historical card IDs", async () => {
		const root = temp();
		const { store, lease } = await planning(root);
		const raw = captureToolEvidence(
			{ ...execution, isError: true },
			{ stateDir: root, runId: "run", leaseId: lease.leaseId },
		);
		store.recordEvidence(lease.leaseId, [raw]);
		const snapshot = store.snapshot("run");
		const graph = emptyHypothesisGraph();
		graph.nodes.push({
			id: "h",
			statement: "local claim",
			status: "testing",
			basisRefs: [],
			parentHypothesisIds: [],
			verificationCriteria: "actual observation",
			refutationCriteria: "contradiction",
			verificationEvidenceRefs: [],
			needsReview: false,
		});
		graph.taskBindings.push({
			taskId: lease.taskId,
			hypothesisIds: ["h"],
			purpose: "test_hypothesis",
			requiredInputs: [],
		});
		const input = card([raw.evidenceId!]);
		store.publishEvidenceCard(lease.leaseId, input);
		expect(graph.nodes[0].status).toBe("testing");
		const observation = {
			expectedVersion: 0,
			card: input,
			resolutions: [
				{
					hypothesisId: "h",
					verdict: "verified" as const,
					explanation: "claimed",
					evidenceRefs: [raw.evidenceId!],
				},
			],
		};
		expect(() => applyHypothesisObservation(graph, observation, snapshot, lease.taskId, lease.leaseId)).toThrow(
			"Tool execution failure",
		);
		const next = applyHypothesisObservation(
			graph,
			{ ...observation, resolutions: [] },
			snapshot,
			lease.taskId,
			lease.leaseId,
		);
		expect(next.cards[0].id).toBe(
			`card_${createHash("sha256")
				.update(`${lease.leaseId}\0${JSON.stringify(input)}`)
				.digest("hex")
				.slice(0, 24)}`,
		);
	});
	it("uses 20/100 card paging, isolates runs, and includes cards published after the first page", () => {
		const db = new DatabaseSync(":memory:");
		cleanup.push(() => db.close());
		const repo = new PlanningEvidenceRepository(db);
		const owner = { runId: "run", taskId: "task", leaseId: "lease" };
		repo.insert(
			owner,
			{ kind: "tool", source: "fixture", summary: "raw", contentHash: "fixture", metadata: {} },
			"ev",
			1,
		);
		for (let n = 0; n < 21; n++) repo.publish(owner, card(["ev"], `finding ${n}`));
		const first = repo.listCards("run");
		expect(first.items).toHaveLength(20);
		expect(first.hasMore).toBe(true);
		repo.publish(owner, card(["ev"], "late finding"));
		const last = repo.listCards("run", first.nextCursor);
		expect(last.items).toHaveLength(2);
		expect(last.hasMore).toBe(false);
		expect(repo.listCards("other").items).toHaveLength(0);
		expect(() => repo.listCards("run", 0, 101)).toThrow("1..100");
		expect(evidenceBoardView(repo.allCards("run"))).toMatchObject({
			totalCount: 22,
			omittedCount: 2,
			semanticVerification: "not_performed",
		});
	});
	it("retains old Cairn rows and cursors while all new writes use the common table", () => {
		const root = temp();
		const path = join(root, "host.sqlite");
		let host = new CairnHostEvidence(path);
		const db = new DatabaseSync(path);
		db.prepare("INSERT INTO tool_evidence VALUES (?,?,?,?,?,?,?,?,?,?)").run(
			"legacy",
			"run",
			"task",
			"solver",
			1,
			"old-call",
			"fixture",
			0,
			JSON.stringify({ text: "old" }),
			1,
		);
		db.close();
		const first = host.list("run", 0, 1);
		expect(first.items[0].evidenceId).toBe("legacy");
		const saved = host.save(intent(), execution);
		host.publishCard(intent(), card([saved.evidenceId]));
		expect(host.list("run", first.nextCursor).items.map((item) => item.evidenceId)).toEqual([saved.evidenceId]);
		expect(host.read("run", "legacy")?.content).toBe(JSON.stringify({ text: "old" }));
		host.close();
		host = new CairnHostEvidence(path);
		cleanup.push(() => host.close());
		expect(host.read("run", saved.evidenceId)).toEqual(saved);
		expect(host.cards("run")).toHaveLength(1);
	});
	it("marks oversized evidence incomplete and cannot derive verifier proof from it", () => {
		const root = temp();
		const host = new CairnHostEvidence(join(root, "host.sqlite"));
		cleanup.push(() => host.close());
		const saved = host.save(intent(), {
			...execution,
			toolName: "verify_flag",
			result: {
				content: [{ type: "text", text: "x".repeat(MAX_EVIDENCE_BLOB_BYTES + 1) }],
				details: { data: { status: "correct", verificationOutcome: "correct" } },
			},
		});
		expect(saved.contentComplete).toBe(false);
		expect(JSON.parse(saved.content).truncated).toBe(true);
		expect(host.proof("run")).toBeUndefined();
	});
	it("detects blob tampering and rejects foreign ownership on host materialization", () => {
		const root = temp();
		const raw = captureToolEvidence(execution, { stateDir: root, runId: "run", leaseId: "lease" });
		const args = {
			stateDir: root,
			contentRef: raw.contentRef!,
			contentHash: raw.contentHash,
			runId: "run",
			evidenceId: raw.evidenceId!,
		};
		expect(() => readCompleteEvidenceBlob({ ...args, runId: "other" })).toThrow("another run");
		writeFileSync(join(root, raw.contentRef!), "tampered");
		expect(() => readCompleteEvidenceBlob(args)).toThrow("hash");
	});
	it("replays recorded model-error metadata through all three mode paths without promoting errors to success", async () => {
		const history = JSON.parse(
			readFileSync(new URL("./fixtures/provider-recovery-history.json", import.meta.url), "utf8"),
		) as { records: { payload: Record<string, unknown>; rowid: number }[] };
		const root = temp();
		const { store, lease } = await planning(root);
		const host = new CairnHostEvidence(join(root, "host.sqlite"));
		cleanup.push(() => host.close());
		for (const entry of history.records.slice(0, 8)) {
			const replay = {
				toolCallId: `history-${entry.rowid}`,
				toolName: "harness_diagnostic",
				isError: true,
				result: { details: { data: entry.payload } },
			};
			const raw = captureToolEvidence(replay, { stateDir: root, runId: "run", leaseId: lease.leaseId });
			store.recordEvidence(lease.leaseId, [raw]);
			const saved = host.save(intent(), replay);
			expect(JSON.parse(saved.content)).toEqual(replay.result);
			expect(saved.isError).toBe(true);
			const input = card([raw.evidenceId!], "Recorded model service error; no solver conclusion");
			store.publishEvidenceCard(lease.leaseId, input);
			const graph = emptyHypothesisGraph();
			graph.taskBindings.push({
				taskId: lease.taskId,
				hypothesisIds: [],
				purpose: "gather_evidence",
				requiredInputs: [],
			});
			const next = applyHypothesisObservation(
				graph,
				{ expectedVersion: 0, card: input, resolutions: [] },
				store.snapshot("run"),
				lease.taskId,
				lease.leaseId,
			);
			expect(next.nodes).toHaveLength(0);
			host.publishCard(intent(), card([saved.evidenceId], input.summary));
		}
		expect(host.proof("run")).toBeUndefined();
		expect(host.cards("run")).toHaveLength(history.records.slice(0, 8).length);
		expect(store.getEvidenceCards("run")).toHaveLength(history.records.slice(0, 8).length);
	});
});
