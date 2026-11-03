import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AttackKnowledgeClientCall,
	buildKnowledgeQuerySpec,
	buildKnowledgeTaskInputs,
	extractToolEvidence,
	formatKnowledgeInjection,
	gateCandidates,
	type KnowledgeCardHit,
	KnowledgeRetrievalCoordinator,
	parseKnowledgeCandidates,
	parsePlanningLeaseSignals,
	queryFingerprint,
	type RetrievalTrigger,
	resolveSolveTask,
	type SolveKnowledgeEvidence,
	type SolveKnowledgeTask,
	sanitizeToolText,
} from "../src/knowledge-retrieval.ts";
import { knowledgeTaskInputToSuggestedTask } from "../src/planning/pi-adapters.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "secheur-knowledge-coordinator-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		record_id: "card-1",
		category: "web",
		kind: "knowledge_card",
		score: 9.5,
		challenge: "SQLi login bypass",
		label: "sql injection",
		attack_pattern: ["sql injection"],
		why_matched: "attack pattern sql injection",
		recognition_signals: ["sql injection", "login bypass"],
		preconditions: ["The login query is string-concatenated."],
		attack_steps: ["Inject ' OR 1=1 --"],
		poc: "",
		canonical_poc: "",
		failure_modes: ["WAF blocks quotes"],
		source_urls: ["https://example.test/sqli"],
		review_status: "draft",
		...overrides,
	};
}

interface ClientHarness {
	calls: Array<{ tool: string; args: Record<string, unknown> }>;
	client: AttackKnowledgeClientCall;
}

function makeClient(
	packets: Array<Record<string, unknown>> | (() => Array<Record<string, unknown>>) = [],
): ClientHarness {
	const calls: ClientHarness["calls"] = [];
	const client = vi.fn(async (_tool: string, args: Record<string, unknown>) => {
		calls.push({ tool: _tool, args });
		const resolved = typeof packets === "function" ? packets() : packets;
		return { ok: true, data: { status: "success", knowledge_packet: resolved } };
	});
	return { calls, client };
}

function makeCoordinator(
	options: {
		stateDir?: string;
		client?: AttackKnowledgeClientCall;
		enabled?: () => boolean;
		sessionAllowed?: boolean;
		turn?: () => number;
		hardTimeoutMs?: number;
		firstRetrievalTimeoutMs?: number;
	} = {},
): KnowledgeRetrievalCoordinator {
	const coordinator = new KnowledgeRetrievalCoordinator({
		stateDir: options.stateDir ?? temporaryRoot(),
		knowledgeBaseEnabled: options.enabled ?? (() => true),
		client: options.client ?? makeClient().client,
		getTurn: options.turn ?? (() => 3),
		...(options.hardTimeoutMs === undefined ? {} : { hardTimeoutMs: options.hardTimeoutMs }),
		...(options.firstRetrievalTimeoutMs === undefined
			? {}
			: { firstRetrievalTimeoutMs: options.firstRetrievalTimeoutMs }),
	});
	coordinator.setSessionAllowed(options.sessionAllowed ?? true);
	return coordinator;
}

const TASK: SolveKnowledgeTask = {
	key: "t-1",
	source: "competition",
	solveMode: true,
	category: "web",
	objective: "exploit this sql injection login bypass",
};
const EVIDENCE: SolveKnowledgeEvidence = {
	revision: 4,
	phase: "exploit",
	techniques: ["sql-injection"],
	targetFacts: ["framework:flask", "route:/login"],
	failedRoutes: [],
};

describe("SolveContextResolver", () => {
	it("treats the competition envelope as authoritative with solveMode", () => {
		const task = resolveSolveTask({
			prompt: "unrelated prompt",
			competition: { taskId: "task-42", category: "Reversing", name: "Rev Me", description: "crack it" },
		});
		expect(task).toMatchObject({ key: "task-42", source: "competition", solveMode: true, category: "reverse" });
	});

	it("rejects competition envelopes outside the four supported categories", () => {
		const task = resolveSolveTask({
			prompt: "find the flag",
			competition: { taskId: "task-9", category: "Forensics", name: "Disk" },
		});
		expect(task).toBeUndefined();
	});

	it("binds verified CTF descriptors with the descriptor target ID", () => {
		const task = resolveSolveTask({
			prompt: "solve the challenge",
			descriptor: {
				isCtf: true,
				requiresVerification: true,
				targetId: "descriptor-7",
				category: "crypto",
				goal: "recover the key",
			},
		});
		expect(task).toMatchObject({ key: "descriptor-7", source: "descriptor", solveMode: false, category: "crypto" });
	});

	it("binds descriptors with an explicit verification requirement", () => {
		const task = resolveSolveTask({
			prompt: "task text",
			descriptor: { isCtf: false, requiresVerification: true, category: "binary" },
		});
		expect(task).toMatchObject({ source: "descriptor", category: "pwn" });
	});

	it("falls back to explicit recognition for non-CTF descriptors", () => {
		const task = resolveSolveTask({
			prompt: "exploit this SQL injection",
			descriptor: { isCtf: false, requiresVerification: false, category: "generic" },
		});
		expect(task).toMatchObject({ source: "explicit", category: "web" });
	});

	it.each([
		["exploit this SQL injection", "web"],
		["solve this heap use-after-free exploit", "pwn"],
		["factor this RSA modulus", "crypto"],
		["reverse this crackme", "reverse"],
	])("recognizes the explicit attack task %s", (prompt, category) => {
		const task = resolveSolveTask({ prompt });
		expect(task).toMatchObject({ source: "explicit", solveMode: false, category });
	});

	it.each([
		"find the flag",
		"fix SQL injection tests",
		"inspect this repository",
		"CTF challenge ID 123",
		"continue",
		"solve this binary search tree test failure",
	])("does not recognize %s as a solve task", (prompt) => {
		expect(resolveSolveTask({ prompt })).toBeUndefined();
	});
});

describe("KnowledgeEvidenceExtractor", () => {
	it("extracts normalized pwn mitigation and binary facts", () => {
		const evidence = extractToolEvidence(
			"code_run",
			"Arch: amd64-64-little RELRO: Full RELRO Stack: Canary found NX: NX enabled PIE: PIE enabled, glibc 2.31",
			"pwn",
		);
		expect(evidence.facts).toEqual(
			expect.arrayContaining(["amd64", "full-relro", "canary", "nx", "pie", "glibc-2.31"]),
		);
	});

	it("records disabled mitigations as negative facts", () => {
		const evidence = extractToolEvidence("code_run", "PIE: No PIE, NX disabled, No canary found", "pwn");
		expect(evidence.facts).toEqual(expect.arrayContaining(["no-pie", "no-nx", "no-canary"]));
		expect(evidence.facts).not.toEqual(expect.arrayContaining(["pie", "nx", "canary"]));
	});

	it("extracts crypto parameters and nonce reuse", () => {
		const evidence = extractToolEvidence(
			"code_run",
			"RSA modulus is 512 bits, e=3, two ciphertexts, nonce reuse observed",
			"crypto",
		);
		expect(evidence.facts).toEqual(
			expect.arrayContaining(["rsa", "modulus-bits=512", "e=3", "samples=2", "nonce-reuse"]),
		);
	});

	it("extracts web framework, routes, and vuln primitives", () => {
		const evidence = extractToolEvidence(
			"web_scan",
			"Flask app, route: /admin, parameter: user, SQL error in login",
			"web",
		);
		expect(evidence.facts).toEqual(expect.arrayContaining(["framework:flask", "route:/admin", "param:user"]));
		expect(evidence.techniques).toContain("sql-injection");
	});

	it("extracts reverse format, packer, and anti-debug facts", () => {
		const evidence = extractToolEvidence(
			"code_run",
			"ELF 64-bit binary packed with UPX and anti-debugging",
			"reverse",
		);
		expect(evidence.facts).toEqual(expect.arrayContaining(["elf", "64-bit", "packer:upx", "anti-debug"]));
	});

	it("strips flags and tokens before normalization", () => {
		const text = "flag{secret_flag_value} token=abc123def456 cookie: session=xyz";
		expect(sanitizeToolText(text)).not.toMatch(/secret_flag_value|abc123def456|xyz/);
		const evidence = extractToolEvidence("code_run", "PIE enabled token=abc123def456", "pwn");
		expect(evidence.facts).toContain("pie");
		expect(evidence.facts.join(" ")).not.toContain("abc123def456");
	});
});

describe("query generation and fingerprints", () => {
	it("is stable across field ordering and alias spellings", () => {
		const base = buildKnowledgeQuerySpec(TASK, EVIDENCE, "evidence_refinement");
		const reordered: typeof base = {
			...base,
			techniques: [...base.techniques].reverse(),
			facts: [...base.facts].reverse(),
		};
		expect(queryFingerprint(reordered)).toBe(queryFingerprint(base));
		const aliased = { ...base, techniques: ["SQL Injection"] };
		expect(queryFingerprint(aliased)).toBe(queryFingerprint(base));
	});

	it("changes when the phase or facts change", () => {
		const base = buildKnowledgeQuerySpec(TASK, EVIDENCE, "evidence_refinement");
		const refined = buildKnowledgeQuerySpec(TASK, { ...EVIDENCE, phase: "recon" }, "evidence_refinement");
		expect(queryFingerprint(refined)).not.toBe(queryFingerprint(base));
	});

	it("formats stable query fields", () => {
		const spec = buildKnowledgeQuerySpec(TASK, EVIDENCE, "evidence_refinement");
		expect(spec.category).toBe("web");
		expect(spec.need).toContain("compatible exploit path");
	});
});

describe("KnowledgeQualityGate", () => {
	function hit(overrides: Partial<KnowledgeCardHit> = {}): KnowledgeCardHit {
		return {
			recordId: "card-1",
			category: "web",
			kind: "knowledge_card",
			score: 9.5,
			challenge: "SQLi login bypass",
			label: "sql injection",
			attackPatterns: ["sql injection"],
			whyMatched: "attack pattern sql injection",
			recognitionSignals: ["sql injection", "login bypass"],
			preconditions: ["The login query is string-concatenated."],
			attackSteps: ["Inject ' OR 1=1 --"],
			poc: "",
			canonicalPoc: "",
			failureModes: ["WAF blocks quotes"],
			sourceUrls: ["https://example.test/sqli"],
			reviewStatus: "draft",
			verificationStatus: "unverified",
			...overrides,
		};
	}

	function gate(overrides: Partial<KnowledgeCardHit>, evidence = EVIDENCE) {
		return gateCandidates([hit(overrides)], {
			category: "web",
			evidence,
			injectedCardIds: [],
			rankedScores: [9.5],
		})[0];
	}

	it("rejects category mismatches", () => {
		expect(gate({ category: "pwn" }).decision).toBe("reject");
		expect(gate({ category: "pwn" }).reasons).toContain("category_mismatch");
	});

	it("rejects already injected cards", () => {
		const outcome = gateCandidates([hit()], {
			category: "web",
			evidence: EVIDENCE,
			injectedCardIds: ["card-1"],
			rankedScores: [9.5],
		})[0];
		expect(outcome.decision).toBe("reject");
		expect(outcome.reasons).toContain("already_injected");
	});

	it("rejects cards without provenance or attack family", () => {
		expect(gate({ sourceUrls: [] }).reasons).toContain("missing_provenance");
		expect(gate({ attackPatterns: [], label: "" }).reasons).toContain("missing_attack_family");
	});

	it("rejects corrupted and empty records", () => {
		expect(gate({ challenge: "bad \ufffd \ufffd text" }).reasons).toContain("corrupted_text");
		expect(gate({ challenge: "", preconditions: [], attackSteps: [], failureModes: [] }).reasons).toContain(
			"empty_body",
		);
	});

	it("rejects candidates whose prerequisites conflict with target facts", () => {
		const outcome = gateCandidates(
			[
				hit({
					category: "pwn",
					attackPatterns: ["return-oriented-programming"],
					preconditions: ["Requires PIE enabled"],
				}),
			],
			{
				category: "pwn",
				evidence: {
					revision: 1,
					phase: "recon",
					techniques: ["return-oriented-programming"],
					targetFacts: ["no-pie"],
					failedRoutes: [],
				},
				injectedCardIds: [],
				rankedScores: [9.5],
			},
		)[0];
		expect(outcome.decision).toBe("reject");
		expect(outcome.applicability).toBe("contradicted");
		expect(outcome.reasons.join(" ")).toContain("precondition_conflicts_with_no-pie");
	});

	it("accepts a strong family match only when every precondition is evidence-backed", () => {
		const outcome = gate({});
		expect(outcome.decision).toBe("accept");
		expect(outcome.applicability).toBe("verified_applicable");
		expect(outcome.missingPreconditions).toEqual([]);
		expect(outcome.satisfiedPreconditions).toEqual(["The login query is string-concatenated."]);
		expect(outcome.score).toBeGreaterThanOrEqual(0.55);
	});

	it("never gives precondition-free cards a free pass", () => {
		// The old prerequisiteFitScore returned 1 when a card declared no
		// conditions, so generic cards outranked specific ones.
		const outcome = gate({ preconditions: [] });
		expect(outcome.applicability).toBe("needs_verification");
		expect(outcome.decision).not.toBe("accept");
		// The card declares nothing, so there is no specific condition to name.
		// Inventing one would point the agent at something the corpus never had.
		expect(outcome.missingPreconditions).toEqual([]);
		// Neutral rather than full credit, and below a card whose conditions the
		// evidence actually confirms.
		expect(outcome.breakdown.prerequisite).toBe(0.5);
		const confirmed = gate(
			{ preconditions: ["the login query is string-concatenated"] },
			{ ...EVIDENCE, targetFacts: ["the login query is string-concatenated"] },
		);
		expect(confirmed.breakdown.prerequisite).toBe(1);
	});

	it("downgrades unconfirmed preconditions to needs_verification", () => {
		const weak = hit({
			challenge: "SQLi auth bypass",
			preconditions: ["Requires an obscure configuration."],
			recognitionSignals: [],
		});
		const outcome = gateCandidates([weak], {
			category: "web",
			evidence: EVIDENCE,
			injectedCardIds: [],
			rankedScores: [weak.score],
			trigger: "task_bootstrap",
		})[0];
		expect(outcome.decision).toBe("needs_verification");
		expect(outcome.applicability).toBe("needs_verification");
		expect(outcome.missingPreconditions).toContain("Requires an obscure configuration.");
	});

	it("honours the Python quality annotation instead of re-deriving a second standard", () => {
		const rejected = gate({ qualityStatus: "rejected", qualityReasons: ["weak_lexical_overlap"] });
		expect(rejected.decision).toBe("reject");
		expect(rejected.reasons).toContain("python_quality_rejected");

		const ambiguous = gate({ qualityStatus: "ambiguous", qualityScore: 0.5 });
		expect(ambiguous.breakdown.pythonQuality).toBe(0.5);
		expect(ambiguous.reasons).toContain("python_unconfirmed_preconditions");
	});

	it("does not re-offer a card already proven inapplicable", () => {
		const outcome = gateCandidates([hit()], {
			category: "web",
			evidence: EVIDENCE,
			injectedCardIds: [],
			rankedScores: [9.5],
			contradictedCardIds: ["card-1"],
		})[0];
		expect(outcome.decision).toBe("reject");
		expect(outcome.reasons).toContain("previously_contradicted");
	});
});

describe("KnowledgeRetrievalCoordinator", () => {
	it("bootstraps a bound task once and injects the formatted block", async () => {
		const harness = makeClient([candidate()]);
		const coordinator = makeCoordinator({ client: harness.client });
		coordinator.attachSession("session-boot");
		coordinator.resolveAndBind({ prompt: "exploit this SQL injection" });

		const snippet = await coordinator.runBootstrap();

		expect(harness.calls).toHaveLength(1);
		const args = harness.calls[0].args;
		expect(args).toMatchObject({ category: "web", top_k: 20, include_full_record: true });
		expect(args.exclude_ids).toEqual([]);
		expect(snippet).toContain('<runtime_attack_knowledge trigger="task_bootstrap"');
		expect(snippet).toContain("card_id: card-1");
		expect(coordinator.getState().retrieval.bootstrapDone).toBe(true);
		expect(coordinator.getState().retrieval.count).toBe(1);

		await coordinator.runBootstrap();
		expect(harness.calls).toHaveLength(1);
	});

	it("never calls the knowledge base when disabled or session-excluded", async () => {
		const disabled = makeCoordinator({ enabled: () => false, client: makeClient([candidate()]).client });
		disabled.attachSession("session-disabled");
		disabled.resolveAndBind({ prompt: "exploit this SQL injection" });
		await disabled.runBootstrap();
		expect(disabled.getState().retrieval.count).toBe(0);

		const excluded = makeCoordinator({ sessionAllowed: false, client: makeClient([candidate()]).client });
		excluded.attachSession("session-excluded");
		excluded.resolveAndBind({ prompt: "exploit this SQL injection" });
		await excluded.runBootstrap();
		expect(excluded.getState().retrieval.count).toBe(0);
	});

	it("keeps task continuity for generic continuations", async () => {
		const coordinator = makeCoordinator({ client: makeClient([candidate()]).client });
		coordinator.attachSession("session-continuity");
		coordinator.resolveAndBind({ prompt: "exploit this SQL injection" });
		await coordinator.runBootstrap();
		const revisionBefore = coordinator.getState().evidence.revision;

		expect(coordinator.resolveAndBind({ prompt: "keep going" })).toBe(false);
		expect(coordinator.resolveAndBind({ prompt: "换个思路" })).toBe(false);
		expect(coordinator.getState().task?.key).toBeTruthy();
		expect(coordinator.getState().evidence.revision).toBe(revisionBefore);

		coordinator.resolveAndBind({ prompt: "factor this RSA modulus" });
		expect(coordinator.getState().task).toMatchObject({ category: "crypto" });
		expect(coordinator.getState().evidence.revision).toBe(0);
	});

	it("extracts evidence and flushes one merged retrieval with the new revision", async () => {
		// Each call returns a fresh card ID: the coordinator refuses to re-inject
		// a card already delivered for this task, so a fixed fixture would only
		// exercise the dedupe path.
		let sequence = 0;
		const harness = makeClient(() => [candidate({ record_id: `card-${++sequence}` })]);
		const coordinator = makeCoordinator({ client: harness.client });
		coordinator.attachSession("session-evidence");
		coordinator.resolveAndBind({ prompt: "exploit this SQL injection" });
		await coordinator.runBootstrap();
		expect(coordinator.getState().evidence.revision).toBe(0);
		const callsBefore = harness.calls.length;

		coordinator.observeToolResult("web_scan", "Flask app route: /login SQL error", false);
		const state = coordinator.getState();
		expect(state.evidence.revision).toBeGreaterThan(0);
		expect(state.retrieval.pendingTrigger).toBe("evidence_refinement");
		expect(state.evidence.targetFacts).toEqual(expect.arrayContaining(["framework:flask", "route:/login"]));

		const injection = await coordinator.flushContext(undefined);
		expect(harness.calls.length).toBe(callsBefore + 1);
		expect(harness.calls[callsBefore].args.query).toContain("route:/login");
		expect(injection).toContain('trigger="evidence_refinement"');
		const revisionAfterRetrieval = coordinator.getState().evidence.revision;
		expect(revisionAfterRetrieval).toBe(state.evidence.revision);
		expect(coordinator.getState().retrieval.pendingTrigger).toBeUndefined();
	});

	it("does not re-search identical fingerprints and excludes injected card IDs", async () => {
		const harness = makeClient([candidate()]);
		const coordinator = makeCoordinator({ client: harness.client });
		coordinator.attachSession("session-dedup");
		coordinator.resolveAndBind({ prompt: "exploit this SQL injection" });
		await coordinator.runBootstrap();
		expect(harness.calls).toHaveLength(1);

		coordinator.observeToolResult("web_scan", "Flask app route: /login", false);
		await coordinator.flushContext(undefined);
		expect(harness.calls).toHaveLength(2);
		expect(harness.calls[1].args.exclude_ids).toEqual(["card-1"]);
	});

	it("recovers on the first stall epoch and throttles later epochs", async () => {
		let sequence = 0;
		const coordinator = makeCoordinator({
			client: makeClient(() => [candidate({ record_id: `card-${++sequence}` })]).client,
		});
		coordinator.attachSession("session-stall");
		coordinator.resolveAndBind({ prompt: "exploit this SQL injection" });
		await coordinator.runBootstrap();
		expect(coordinator.getState().retrieval.recoveryEpoch).toBe(0);

		const first = await coordinator.flushContext("stuck");
		expect(first).toContain('trigger="stall_recovery"');
		expect(coordinator.getState().retrieval.recoveryEpoch).toBe(1);

		// streak 2 is throttled; streak 3 enters a new epoch but the identical
		// fingerprint is never re-searched
		expect(await coordinator.flushContext("stuck")).toBeUndefined();
		expect(coordinator.getState().retrieval.recoveryEpoch).toBe(1);
		expect(await coordinator.flushContext("stuck")).toBeUndefined();
		expect(coordinator.getState().retrieval.recoveryEpoch).toBe(3);

		// a recovery verdict resets the streak; the next stall period triggers again
		await coordinator.flushContext("course_correct");
		expect(await coordinator.flushContext("stuck")).toBeUndefined();
		expect(coordinator.getState().retrieval.recoveryEpoch).toBe(3);
	});

	it("fails open on timeout and empty results without blocking", async () => {
		const hanging = makeCoordinator({
			client: async () => new Promise(() => undefined) as never,
			hardTimeoutMs: 30,
			// The first retrieval of a task normally gets a longer budget to pay
			// the cold index load; this client never answers, so keep both short.
			firstRetrievalTimeoutMs: 30,
		});
		hanging.attachSession("session-timeout");
		hanging.resolveAndBind({ prompt: "exploit this SQL injection" });
		const snippet = await hanging.runBootstrap();
		expect(snippet).toBeUndefined();
		expect(hanging.getState().retrieval.count).toBe(1);
		// A transient failure must not be recorded as a completed bootstrap.
		expect(hanging.getState().retrieval.bootstrapDone).toBe(false);
		expect(
			hanging.getState().retrieval.queryStates[Object.keys(hanging.getState().retrieval.queryStates)[0]],
		).toMatchObject({ status: "timeout", attempts: 1 });

		const empty = makeCoordinator({ client: makeClient([]).client });
		empty.attachSession("session-empty");
		empty.resolveAndBind({ prompt: "exploit this SQL injection" });
		expect(await empty.runBootstrap()).toBeUndefined();
		expect(empty.getState().retrieval.bootstrapDone).toBe(true);
	});

	it("retries a timed-out query instead of parking it for the whole task", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const coordinator = new KnowledgeRetrievalCoordinator({
			stateDir: temporaryRoot(),
			knowledgeBaseEnabled: () => true,
			client: async (_tool, args) => {
				calls.push(args);
				if (calls.length === 1) return new Promise(() => undefined) as never;
				return { ok: true, data: { status: "success", knowledge_packet: [candidate()] } };
			},
			getTurn: () => 2,
			hardTimeoutMs: 25,
			firstRetrievalTimeoutMs: 25,
		});
		coordinator.attachSession("session-retry");
		coordinator.resolveAndBind({ prompt: "exploit this SQL injection" });

		expect(await coordinator.runBootstrap()).toBeUndefined();
		const retried = await coordinator.runBootstrap();
		expect(retried).toContain("card_id: card-1");
		expect(calls).toHaveLength(2);
		expect(coordinator.getState().retrieval.bootstrapDone).toBe(true);
	});

	it("stops retrying after the bounded attempt budget", async () => {
		let calls = 0;
		const coordinator = new KnowledgeRetrievalCoordinator({
			stateDir: temporaryRoot(),
			knowledgeBaseEnabled: () => true,
			client: async () => {
				calls += 1;
				throw new Error("worker unavailable");
			},
			getTurn: () => 1,
			hardTimeoutMs: 25,
		});
		coordinator.attachSession("session-retry-exhausted");
		coordinator.resolveAndBind({ prompt: "exploit this SQL injection" });
		for (let attempt = 0; attempt < 5; attempt += 1) await coordinator.runBootstrap();
		expect(calls).toBeLessThanOrEqual(3);
		expect(coordinator.getState().retrieval.bootstrapDone).toBe(false);
	});

	it("records knowledge_used when injected preconditions become evidence-backed", async () => {
		const root = temporaryRoot();
		const coordinator = makeCoordinator({ stateDir: root, client: makeClient([candidate()]).client });
		coordinator.attachSession("session-used");
		coordinator.resolveAndBind({ prompt: "exploit this SQL injection" });
		await coordinator.runBootstrap();

		coordinator.observeToolResult("file_read", "route: /login query is a string concatenated SQL statement", false);

		const auditPath = join(root, "runtime", "sessions", "session-used", "knowledge-retrieval.jsonl");
		const entries = readFileSync(auditPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const used = entries.find((entry) => entry.event === "knowledge_used");
		expect(used).toBeDefined();
		expect(used?.knowledge_id).toBe("card-1");
		expect((used?.detail as Record<string, unknown>).satisfied_preconditions).toEqual([
			"The login query is string-concatenated.",
		]);
	});

	it("limits injection to the card and character budgets", async () => {
		// Distinct techniques, so the budget is what limits the injection and not
		// the same-family rule, which would otherwise collapse them to one card.
		const packets = [
			candidate(),
			candidate({
				record_id: "card-2",
				attack_pattern: ["format string"],
				recognition_signals: ["format string leak"],
				preconditions: ["An attacker-controlled format string reaches printf."],
			}),
			candidate({
				record_id: "card-3",
				attack_pattern: ["integer overflow"],
				recognition_signals: ["heap corruption via overflow"],
				preconditions: ["An unchecked allocation size feeds memcpy."],
			}),
			candidate({
				record_id: "card-4",
				attack_pattern: ["race condition"],
				recognition_signals: ["toctou on a shared file"],
				preconditions: ["The check and the use are separated in time."],
			}),
		];
		const coordinator = makeCoordinator({ client: makeClient(packets).client });
		coordinator.attachSession("session-budget");
		coordinator.resolveAndBind({ prompt: "exploit this SQL injection" });
		const snippet = await coordinator.runBootstrap();
		const formatted = snippet ?? "";
		expect(formatted).toContain("card_id: card-1");
		expect(formatted).toContain("card_id: card-3");
		expect(formatted).not.toContain("card_id: card-4");
		expect(formatted.length).toBeLessThanOrEqual(10_000);

		const small = new KnowledgeRetrievalCoordinator({
			stateDir: temporaryRoot(),
			knowledgeBaseEnabled: () => true,
			client: makeClient(packets).client,
			getTurn: () => 1,
			maxInjectedCharacters: 500,
		});
		small.attachSession("session-small-budget");
		small.resolveAndBind({ prompt: "exploit this SQL injection" });
		const smallSnippet = (await small.runBootstrap()) ?? "";
		expect(smallSnippet.length).toBeLessThanOrEqual(500 + 40);
	});

	it("persists only normalized facts, hashes, and card IDs", async () => {
		const root = temporaryRoot();
		const harness = makeClient([candidate()]);
		const coordinator = makeCoordinator({ stateDir: root, client: harness.client });
		coordinator.attachSession("session-persist");
		coordinator.resolveAndBind({ prompt: "exploit this SQL injection" });
		await coordinator.runBootstrap();

		const statePath = join(root, "runtime", "sessions", "session-persist", "knowledge-state.json");
		expect(existsSync(statePath)).toBe(true);
		const raw = readFileSync(statePath, "utf8");
		expect(raw).not.toContain("SQL injection");
		expect(raw).not.toContain("exploit");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		expect((parsed.task as Record<string, unknown>).keyHash).toEqual(expect.any(String));

		const auditPath = join(root, "runtime", "sessions", "session-persist", "knowledge-retrieval.jsonl");
		expect(existsSync(auditPath)).toBe(true);
		const auditLines = readFileSync(auditPath, "utf8").trim().split("\n");
		expect(auditLines.length).toBeGreaterThanOrEqual(2);
		const entries = auditLines.map((line) => JSON.parse(line) as Record<string, unknown>);
		// Decision trace: retrieval, then evaluation with per-card gate scores.
		const retrieved = entries.find((item) => item.event === "knowledge_retrieved");
		expect(retrieved).toBeDefined();
		expect((retrieved?.detail as Record<string, unknown>).candidates).toBeDefined();
		const evaluated = entries.filter((item) => item.event === "knowledge_evaluated").at(-1);
		expect(evaluated).toMatchObject({
			session_id: "session-persist",
			trigger: "task_bootstrap",
			allowed: true,
		});
		expect(evaluated?.decision).toBe("injected_candidates");
		expect(evaluated?.accepted_ids).toEqual(["card-1"]);
		expect(evaluated?.query_fingerprint).toEqual(expect.any(String));
		const gateScores = evaluated?.gate_scores as Array<Record<string, unknown>>;
		expect(gateScores[0]).toMatchObject({
			card_id: "card-1",
			gate_decision: "needs_verification",
			applicability: "needs_verification",
			gate_threshold: 0.55,
		});
		for (const field of [
			"taxonomy_score",
			"evidence_score",
			"prerequisite_score",
			"provenance_score",
			"margin_score",
			"final_score",
			"missing_conditions",
		]) {
			expect(gateScores[0]).toHaveProperty(field);
		}
	});

	it("reloads the retrieval ledger from persisted state", async () => {
		const root = temporaryRoot();
		const first = makeCoordinator({ stateDir: root, client: makeClient([candidate()]).client });
		first.attachSession("session-reload");
		first.resolveAndBind({ prompt: "exploit this SQL injection" });
		await first.runBootstrap();

		const second = makeCoordinator({ stateDir: root, client: makeClient([candidate()]).client });
		second.attachSession("session-reload");
		second.resolveAndBind({ prompt: "exploit this SQL injection" });
		await second.runBootstrap();
		expect(second.getState().retrieval.bootstrapDone).toBe(true);
		expect(second.getState().retrieval.injectedCardIds).toEqual(["card-1"]);
		expect(second.getState().retrieval.count).toBe(1);
	});

	it("binds the competition envelope and switches to runtime-only solve mode", async () => {
		const coordinator = makeCoordinator({ client: makeClient([candidate()]).client });
		coordinator.attachSession("session-envelope");
		coordinator.bindCompetitionEnvelope({
			taskId: "comp-7",
			category: "Web",
			name: "Login",
			description: "SQL injection bypass",
		});
		expect(coordinator.isSolveMode()).toBe(true);
		expect(coordinator.getState().task).toMatchObject({ key: "comp-7", category: "web" });
		const snippet = await coordinator.runBootstrap();
		expect(snippet).toContain('<runtime_attack_knowledge trigger="task_bootstrap"');
	});
});

describe("injection formatting", () => {
	it("publishes retrieval quality and applicability instead of a fake confidence", () => {
		const match = parseKnowledgeCandidates({ knowledge_packet: [candidate()] })[0];
		const formatted = formatKnowledgeInjection(
			[{ match, score: 0.84, applicability: "verified_applicable", missingPreconditions: [] }],
			"evidence_refinement" as RetrievalTrigger,
			4,
			3,
			10_000,
		);
		expect(formatted).toContain('<runtime_attack_knowledge trigger="evidence_refinement" revision="4"');
		for (const field of [
			"card_id:",
			"category:",
			"attack_family:",
			"retrieval_quality_score: 0.84",
			"applicability: verified_applicable",
			"why_matched:",
			"recognition_signals:",
			"preconditions:",
			"attack_steps:",
			"canonical_poc:",
			"failure_modes:",
			"source_urls:",
			"review_status:",
		]) {
			expect(formatted).toContain(field);
		}
		// A retrieval score is not a calibrated success probability.
		expect(formatted).not.toContain("confidence:");
		expect(formatted).toContain("</runtime_attack_knowledge>");
	});

	it("keeps unverified candidates short: no steps and no PoC", () => {
		const match = parseKnowledgeCandidates({
			knowledge_packet: [
				candidate({
					canonical_poc: "curl 'http://target/?id=1 OR 1=1'",
					attack_steps: ["Inject the payload", "Dump the table"],
				}),
			],
		})[0];
		const formatted = formatKnowledgeInjection(
			[
				{
					match,
					score: 0.52,
					applicability: "needs_verification",
					missingPreconditions: ["Confirm the login query is string-concatenated."],
				},
			],
			"task_bootstrap" as RetrievalTrigger,
			0,
			3,
			10_000,
			{ compact: true },
		);
		expect(formatted).toContain("applicability: needs_verification");
		expect(formatted).toContain("missing_preconditions: Confirm the login query is string-concatenated.");
		expect(formatted).toContain("usage_policy: verify_before_deeper_execution");
		expect(formatted).not.toContain("canonical_poc:");
		expect(formatted).not.toContain("attack_steps:");
		expect(formatted).toContain('mode="verification_candidates"');
	});
});

describe("knowledge to task input", () => {
	it("names the observation that settles an unverified candidate and caps its cost", () => {
		const match = parseKnowledgeCandidates({ knowledge_packet: [candidate()] })[0];
		const inputs = buildKnowledgeTaskInputs(
			[
				{
					match,
					score: 0.49,
					applicability: "needs_verification",
					missingPreconditions: ["The login query is string-concatenated."],
					satisfiedPreconditions: [],
				},
			],
			EVIDENCE,
		);
		expect(inputs).toHaveLength(1);
		expect(inputs[0]).toMatchObject({
			knowledge_id: "card-1",
			technique: "sql injection",
			retrieval_rank: 1,
			applicability: "needs_verification",
			estimated_cost: "low",
			usage_policy: "verify_before_deeper_execution",
			suggested_action: { skill: "verify_precondition" },
		});
		expect(inputs[0].suggested_action.goal).toContain("The login query is string-concatenated.");
		// Nothing in the observed facts backs an unverified technique, and the
		// card's own text is never used as support.
		expect(inputs[0].supporting_evidence).toEqual([]);
	});

	it("schedules a verified method as an apply-then-record task", () => {
		const match = parseKnowledgeCandidates({ knowledge_packet: [candidate()] })[0];
		const [input] = buildKnowledgeTaskInputs(
			[
				{
					match,
					score: 0.79,
					applicability: "verified_applicable",
					missingPreconditions: [],
					satisfiedPreconditions: ["The login query is string-concatenated."],
				},
			],
			EVIDENCE,
		);
		const task = knowledgeTaskInputToSuggestedTask(input);
		expect(input.estimated_cost).toBe("medium");
		expect(input.usage_policy).toBe("execute_after_verification");
		expect(task.objective).toContain("knowledge:card-1");
		expect(task.doneWhen).toContain("acceptance:");
		expect(task.dependsOnCurrent).toBe(true);
		// The satisfied precondition is what makes the backing fact observable.
		expect(input.supporting_evidence).toEqual(["route:/login"]);
	});

	it("requires a contradiction report instead of a retry for unverified work", () => {
		const match = parseKnowledgeCandidates({ knowledge_packet: [candidate()] })[0];
		const [input] = buildKnowledgeTaskInputs(
			[
				{
					match,
					score: 0.49,
					applicability: "needs_verification",
					missingPreconditions: ["The login query is string-concatenated."],
					satisfiedPreconditions: [],
				},
			],
			EVIDENCE,
		);
		const task = knowledgeTaskInputToSuggestedTask(input);
		expect(input.suggested_action.skill).toBe("verify_precondition");
		expect(task.doneWhen).toContain("rejected instead of retrying");
		expect(task.dependsOnCurrent).toBeUndefined();
	});
});

// ============================================================================
// Planning-executor lease retrieval (execution-focused knowledge)
// ============================================================================

function planningExecutorPrompt(leaseOverrides: Record<string, unknown> = {}): string {
	const lease = {
		schemaVersion: 1,
		leaseId: "lease-1",
		runId: "planning_abc",
		taskId: "plan_x",
		planRevision: 3,
		objective: "Exploit the format string bug to leak the flag",
		doneWhen: "a flag candidate is persisted with verifier evidence",
		allowedScope: "/tmp/target",
		issuedAt: 1,
		expiresAt: 2,
		...leaseOverrides,
	};
	const context = JSON.stringify(
		{
			run: { runId: "planning_abc", goal: "solve the challenge", revision: 3 },
			task: lease,
			executionFrame: { taskSummaries: [], facts: [], rejectedDirections: [], openQuestions: [], artifacts: [] },
			relevantEvidence: [],
		},
		null,
		2,
	);
	return [
		"You are executing exactly one leased task in a progressive plan.",
		"Do not broaden the scope or rewrite the global plan. Commit a structured grounded report when finished.",
		context,
	].join("\n\n");
}

const PWN_CARD: Record<string, unknown> = {
	category: "pwn",
	record_id: "pwn-card-1",
	kind: "knowledge_card",
	score: 9.0,
	challenge: "fmt leak",
	label: "format string",
	attack_pattern: ["format-string"],
	why_matched: "attack pattern format-string",
	recognition_signals: ["format string", "%p leak"],
	preconditions: ["Format function receives user-controlled format string."],
	attack_steps: ["Leak stack with %p", "Build the leak payload"],
	poc: "",
	canonical_poc: "payload = b'%p'*8",
	failure_modes: ["CRLF filtering"],
	source_urls: ["https://example.test/fmt"],
	review_status: "draft",
};

describe("parsePlanningLeaseSignals", () => {
	it("parses the lease objective and doneWhen from a rendered executor context", () => {
		const signals = parsePlanningLeaseSignals(planningExecutorPrompt());
		expect(signals).toMatchObject({
			objective: "Exploit the format string bug to leak the flag",
			doneWhen: "a flag candidate is persisted with verifier evidence",
		});
	});

	it("returns undefined for ordinary prompts and supervisor contexts", () => {
		expect(parsePlanningLeaseSignals("please fix the repository tests")).toBeUndefined();
		expect(parsePlanningLeaseSignals(JSON.stringify({ run: { goal: "x" }, tasks: [] }))).toBeUndefined();
	});

	it("falls back to regex extraction when the rendered JSON is truncated", () => {
		const prompt = planningExecutorPrompt().slice(0, 900);
		const signals = parsePlanningLeaseSignals(prompt);
		expect(signals).toMatchObject({
			objective: "Exploit the format string bug to leak the flag",
			doneWhen: "a flag candidate is persisted with verifier evidence",
		});
	});
});

describe("runLeaseRetrieval", () => {
	it("runs one fine-grained retrieval per lease and injects accepted cards", async () => {
		const harness = makeClient([PWN_CARD]);
		const coordinator = makeCoordinator({ client: harness.client, stateDir: temporaryRoot() });
		coordinator.attachSession("session-lease");
		const snippet = await coordinator.runLeaseRetrieval({
			objective: "Exploit the format string bug to leak the flag",
			doneWhen: "a flag candidate is persisted with verifier evidence",
		});
		expect(snippet).toContain("card_id: pwn-card-1");
		expect(snippet).toContain('trigger="lease_bootstrap"');
		expect(harness.calls).toHaveLength(1);
		const query = harness.calls[0].args.query as string;
		// Only the task-specific terms are sent: the field names and the fixed
		// `need` phrases are identical on every task and would just dilute the
		// ranking, so they are deliberately absent.
		expect(query).toContain("pwn");
		expect(query).toContain("Exploit the format string bug to leak the flag");
		expect(query).toContain("format-string");
		expect(query).not.toContain("category=");
		expect(query).not.toContain("need=");
		expect(query).not.toContain("techniques=");
	});

	it("never re-retrieves the same lease objective but excludes lease cards for new leases", async () => {
		const harness = makeClient([PWN_CARD]);
		const coordinator = makeCoordinator({ client: harness.client });
		coordinator.attachSession("session-lease-dedup");
		const lease = { objective: "Exploit the format string bug to leak the flag", doneWhen: "flag" };
		await coordinator.runLeaseRetrieval(lease);
		expect(await coordinator.runLeaseRetrieval(lease)).toBeUndefined();
		expect(harness.calls).toHaveLength(1);

		await coordinator.runLeaseRetrieval({ objective: "overflow the stack canary via off-by-one", doneWhen: "shell" });
		expect(harness.calls).toHaveLength(2);
		expect(harness.calls[1].args.exclude_ids).toContain("pwn-card-1");
	});

	it("reads the parent task context for category and gate evidence without mutating the ledger", async () => {
		const harness = makeClient([PWN_CARD]);
		const coordinator = makeCoordinator({ client: harness.client });
		coordinator.attachSession("session-lease-shared");
		coordinator.resolveAndBind({ prompt: "exploit this format string binary" });
		await coordinator.runBootstrap();
		const callsBefore = harness.calls.length;
		const parentCount = coordinator.getState().retrieval.count;

		await coordinator.runLeaseRetrieval({
			objective: "pivot the stack with the format string bug",
			doneWhen: "shell",
		});
		expect(harness.calls.length).toBe(callsBefore + 1);
		// The outer-task ledger is untouched: the lease keeps its own ledger.
		expect(coordinator.getState().retrieval.count).toBe(parentCount);
		expect(coordinator.getState().retrieval.injectedCardIds).not.toContain("pwn-card-1");
	});

	it("stays silent when the knowledge base is disabled", async () => {
		const harness = makeClient([PWN_CARD]);
		const coordinator = makeCoordinator({ client: harness.client, enabled: () => false });
		coordinator.attachSession("session-lease-disabled");
		expect(
			await coordinator.runLeaseRetrieval({ objective: "exploit the format string bug", doneWhen: "flag" }),
		).toBeUndefined();
		expect(harness.calls).toHaveLength(0);
	});
});

describe("injection admission", () => {
	/** A card whose only strength is a lexical match on the objective. */
	function weakCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return candidate({
			record_id: "card-weak",
			label: "generic memory note",
			attack_pattern: ["generic note"],
			recognition_signals: ["generic note"],
			preconditions: [],
			score: 1,
			...overrides,
		});
	}

	it("withholds a weakly-matching card instead of padding it into the context", async () => {
		const harness = makeClient([weakCard()]);
		const coordinator = makeCoordinator({ client: harness.client });
		coordinator.attachSession("session-weak");
		coordinator.resolveAndBind({ prompt: "exploit this SQL injection bypass" });

		expect(await coordinator.runBootstrap()).toBeUndefined();
	});

	it("keeps a card that matches the task even with unconfirmed preconditions", async () => {
		const harness = makeClient([
			candidate({
				record_id: "card-strong",
				attack_pattern: ["sql injection"],
				recognition_signals: ["sql injection"],
				preconditions: ["the login query is string-concatenated"],
			}),
		]);
		const coordinator = makeCoordinator({ client: harness.client });
		coordinator.attachSession("session-strong");
		coordinator.resolveAndBind({ prompt: "exploit this SQL injection bypass" });

		const snippet = await coordinator.runBootstrap();
		expect(snippet).toContain("card_id: card-strong");
	});

	it("scores the lone candidate as the leader rather than as unranked", () => {
		const [outcome] = gateCandidates(parseKnowledgeCandidates({ knowledge_packet: [candidate()] }), {
			category: "web",
			evidence: { revision: 0, phase: "", techniques: ["sql-injection"], targetFacts: [], failedRoutes: [] },
			injectedCardIds: [],
			contradictedCardIds: [],
			objective: "exploit this SQL injection",
			trigger: "task_bootstrap",
		});
		expect(outcome.breakdown?.margin).toBe(1);
	});

	it("keeps only the highest-scoring card when several tie on every signal", async () => {
		const duplicates = [
			candidate({ record_id: "card-a" }),
			candidate({ record_id: "card-b" }),
			candidate({ record_id: "card-c" }),
		];
		const harness = makeClient(duplicates);
		const coordinator = makeCoordinator({ client: harness.client });
		coordinator.attachSession("session-ties");
		coordinator.resolveAndBind({ prompt: "exploit this SQL injection bypass" });

		const snippet = await coordinator.runBootstrap();
		const injected = [...(snippet ?? "").matchAll(/card_id: (\S+)/gu)].map((match) => match[1]);
		expect(new Set(injected).size).toBe(injected.length);
	});

	it("collapses restatements of one technique but keeps a different one", async () => {
		const harness = makeClient([
			candidate({ record_id: "same-1" }),
			candidate({ record_id: "same-2" }),
			candidate({ record_id: "same-3" }),
			candidate({
				record_id: "other-1",
				attack_pattern: ["integer overflow"],
				recognition_signals: ["heap corruption via overflow"],
				preconditions: ["An unchecked allocation size feeds memcpy."],
			}),
		]);
		const coordinator = makeCoordinator({ client: harness.client });
		coordinator.attachSession("session-family");
		coordinator.resolveAndBind({ prompt: "exploit this SQL injection bypass" });

		const snippet = await coordinator.runBootstrap();
		const injected = [...(snippet ?? "").matchAll(/card_id: (\S+)/gu)].map((match) => match[1]);

		// Three cards describing one technique collapse to one; the unrelated
		// technique still earns a slot, because the budget should buy knowledge
		// rather than restatements.
		expect(injected).toHaveLength(2);
		expect(injected).toContain("same-1");
		expect(injected).toContain("other-1");
	});
});

describe("ablation audit fields", () => {
	function auditEntries(stateDir: string, sessionId: string): Record<string, unknown>[] {
		const path = join(stateDir, "runtime", "sessions", sessionId, "knowledge-retrieval.jsonl");
		return readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	it("reports what reached the model context and the corpus behind it", async () => {
		const root = temporaryRoot();
		const client = vi.fn(async () => ({
			ok: true,
			data: {
				status: "success",
				knowledge_packet: [candidate()],
				knowledge_base: {
					schema_version: "attack-memory-index.v1",
					record_count: 7625,
					card_fingerprint: "99cbcbab268529bd",
				},
			},
		}));
		const coordinator = makeCoordinator({ stateDir: root, client });
		coordinator.attachSession("session-ablation");
		coordinator.resolveAndBind({ prompt: "exploit this SQL injection" });
		const snippet = await coordinator.runBootstrap();

		// The runtime emits a retrieval event and an evaluation event per query;
		// both must carry the switch state so an off-run is never ambiguous.
		const entries = auditEntries(root, "session-ablation");
		expect(entries.length).toBeGreaterThanOrEqual(2);
		for (const row of entries) {
			expect(row.knowledge_base_enabled).toBe(true);
			expect(row.knowledge_base_snapshot).toEqual({
				schema_version: "attack-memory-index.v1",
				record_count: 7625,
				card_fingerprint: "99cbcbab268529bd",
			});
			expect(row.retrieval_latency_ms).toEqual(expect.any(Number));
		}

		const evaluated = entries.find((row) => row.event === "knowledge_evaluated");
		expect(evaluated?.injected_into_context).toBe(snippet !== undefined);
		// The logged context cost must be the rendered text, not a per-card estimate.
		expect(evaluated?.injected_characters).toBe(snippet?.length ?? 0);
		expect(evaluated?.injected_card_ids).toEqual(evaluated?.accepted_ids);
	});

	it("marks a disabled knowledge base instead of reporting an empty result", async () => {
		const root = temporaryRoot();
		const harness = makeClient([candidate()]);
		const coordinator = makeCoordinator({ stateDir: root, client: harness.client, enabled: () => false });
		coordinator.attachSession("session-ablation-off");
		coordinator.resolveAndBind({ prompt: "exploit this SQL injection" });
		expect(await coordinator.runBootstrap()).toBeUndefined();

		const entry = auditEntries(root, "session-ablation-off")[0];
		// An ablation run must read as "switched off", not as "found nothing".
		expect(entry).toMatchObject({ allowed: false, knowledge_base_enabled: false });
		expect(harness.calls).toHaveLength(0);
	});

	it("audits model-initiated searches so a passive agent is distinguishable", () => {
		const root = temporaryRoot();
		const coordinator = makeCoordinator({ stateDir: root, client: makeClient([candidate()]).client });
		coordinator.attachSession("session-ablation-manual");
		coordinator.resolveAndBind({ prompt: "exploit this SQL injection" });

		coordinator.recordManualRetrieval({
			query: "sql injection in flask login",
			ok: true,
			candidateCount: 1,
			returnedCardIds: ["card-1"],
			injectedCharacters: 1234,
			latencyMs: 42,
		});

		const entries = auditEntries(root, "session-ablation-manual");
		const entry = entries[entries.length - 1];
		expect(entry).toMatchObject({
			trigger: "manual_tool",
			decision: "model_initiated_retrieval",
			allowed: true,
			knowledge_base_enabled: true,
			injected_card_ids: ["card-1"],
			injected_characters: 1234,
			injected_into_context: true,
		});
		expect(entry.retrieval_latency_ms).toBe(42);
	});
});
