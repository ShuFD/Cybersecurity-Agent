/**
 * Runtime state machine for proactive attack-knowledge RAG.
 *
 * The coordinator owns "when to search, what to search, and whether to inject".
 * Python only retrieves and returns structured results; the main LLM never calls
 * the knowledge base. Retrieval policy lives in TypeScript because this layer
 * owns session tool boundaries, the knowledge-base switch, the competition
 * envelope, Pi lifecycle hooks, and sub-agent relationships. The Python handler
 * is reset by `__task_start` and is therefore unsuitable for holding policy
 * state.
 *
 * Everything in this module is deterministic: no LLM calls are introduced on
 * the mandatory retrieval path.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

export type AttackCategory = "web" | "pwn" | "crypto" | "reverse";
export type SolveTaskSource = "competition" | "descriptor" | "explicit";
export type RetrievalTrigger = "task_bootstrap" | "evidence_refinement" | "stall_recovery" | "manual_tool";

/**
 * Final gate decision. Applicability is three-state (see
 * {@link ApplicabilityState}); "accept" is reserved for cards whose key
 * preconditions are backed by current evidence, "needs_verification" injects a
 * short candidate direction without steps or PoC.
 */
export type KnowledgeGateDecision = "accept" | "needs_verification" | "reject";

/** Three-state applicability, evaluated once per candidate in TypeScript. */
export type ApplicabilityState = "verified_applicable" | "needs_verification" | "contradicted";

export const ATTACK_CATEGORIES: readonly AttackCategory[] = ["web", "pwn", "crypto", "reverse"];

/** The solve task bound to this session. Absent until a supported solve task is recognized. */
export interface SolveKnowledgeTask {
	/** Competition task ID first, then descriptor target ID, then a stable hash of the initial task summary. */
	key: string;
	source: SolveTaskSource;
	/** Competition envelopes are authoritative inputs; only they set solveMode. */
	solveMode: boolean;
	category?: AttackCategory;
	objective: string;
}

export interface SolveKnowledgeEvidence {
	/** Bumped only when tool results contribute new normalized facts, techniques, or phase changes. */
	revision: number;
	phase: string;
	techniques: string[];
	targetFacts: string[];
	failedRoutes: string[];
	failureSignature?: string;
}

/** Terminal outcome of one retrieval attempt for a query fingerprint. */
export type QueryOutcomeStatus = "success" | "empty" | "timeout" | "error";

export interface QueryOutcomeState {
	status: QueryOutcomeStatus;
	/** Attempts spent on this fingerprint (only timeout/error may be retried). */
	attempts: number;
	/** Evidence revision at the last attempt; new evidence re-opens the query. */
	revision: number;
	/** Turn at the last attempt; used for the empty-result TTL. */
	turn: number;
}

export interface RetrievalLedger {
	bootstrapDone: boolean;
	pendingTrigger?: RetrievalTrigger;
	/** Successful retrieval calls performed for the current task. */
	count: number;
	/** SHA-256 fingerprints of queries that settled with a definitive result. */
	seenQueryFingerprints: string[];
	/** Card/record IDs already injected into the model context. */
	injectedCardIds: string[];
	/** Highest stall epoch already handled by a stall_recovery retrieval. */
	recoveryEpoch: number;
	/** Evidence revision for which the single deterministic rewrite has already run. */
	refinedForRevision?: number;
	/** Per-fingerprint outcome cache: only success is permanent dedupe. */
	queryStates: Record<string, QueryOutcomeState>;
	/** Cards proven inapplicable for this task; never re-offered for the same evidence. */
	contradictedCardIds: string[];
}

export interface SolveKnowledgeState {
	task?: SolveKnowledgeTask;
	evidence: SolveKnowledgeEvidence;
	retrieval: RetrievalLedger;
}

export interface CompetitionSolveContext {
	taskId: string;
	category?: string;
	name?: string;
	description?: string;
}

export interface TaskDescriptorContext {
	isCtf: boolean;
	requiresVerification: boolean;
	targetId?: string;
	category?: string;
	goal?: string;
	taskText?: string;
}

export interface SolveContextInput {
	prompt: string;
	competition?: CompetitionSolveContext;
	descriptor?: TaskDescriptorContext;
}

export interface KnowledgeQuerySpec {
	category?: AttackCategory;
	phase: string;
	objective: string;
	techniques: string[];
	facts: string[];
	failedRoutes: string[];
	need: string[];
}

export interface KnowledgeCardHit {
	recordId: string;
	category: string;
	kind: string;
	score: number;
	challenge: string;
	label: string;
	attackPatterns: string[];
	whyMatched: string;
	recognitionSignals: string[];
	preconditions: string[];
	attackSteps: string[];
	poc: string;
	canonicalPoc: string;
	failureModes: string[];
	sourceUrls: string[];
	reviewStatus: string;
	verificationStatus: string;
	/** Python-side data-quality annotation: accepted | ambiguous | rejected. */
	qualityStatus?: string;
	qualityScore?: number;
	qualityReasons?: string[];
}

/** Deterministic score components, stored verbatim in the decision trace. */
export interface GateScoreBreakdown {
	taxonomy: number;
	evidence: number;
	prerequisite: number;
	provenance: number;
	margin: number;
	pythonQuality: number;
	final: number;
	threshold: number;
}

export interface GateOutcome {
	decision: KnowledgeGateDecision;
	applicability: ApplicabilityState;
	/** Normalized quality score in [0, 1]; ranking signal only, never confidence. */
	score: number;
	reasons: string[];
	satisfiedPreconditions: string[];
	missingPreconditions: string[];
	breakdown: GateScoreBreakdown;
	match: KnowledgeCardHit;
}

export interface ExtractedEvidence {
	facts: string[];
	techniques: string[];
	/** Suggested phase transition when the evidence proves exploit primitives. */
	phase?: string;
	/** Normalized failure route recorded when the tool result reports an error. */
	failedRoute?: string;
}

export interface AttackKnowledgeClientResponse {
	ok: boolean;
	data?: unknown;
	content?: string;
	nextPrompt?: string;
	error?: string;
}

export type AttackKnowledgeClientCall = (
	tool: "attack_memory_search",
	args: Record<string, unknown>,
) => Promise<AttackKnowledgeClientResponse>;

export interface KnowledgeRetrievalCoordinatorOptions {
	stateDir: string;
	knowledgeBaseEnabled(): boolean;
	client: AttackKnowledgeClientCall;
	getTurn(): number;
	shadow?: boolean;
	maxInjectedCards?: number;
	maxInjectedCharacters?: number;
	/** Hard budget for one retrieval decision; the legacy call continues in the background on timeout (fail-open). */
	hardTimeoutMs?: number;
	/** Budget for the first retrieval of a task, which pays the cold index load. */
	firstRetrievalTimeoutMs?: number;
	/** Budget for the first retrieval of a task, which pays the cold index load. */
}

/** Per-candidate gate components, persisted in the decision trace. */
export interface GateAuditScore {
	card_id: string;
	trigger: string;
	taxonomy_score: number;
	evidence_score: number;
	prerequisite_score: number;
	provenance_score: number;
	margin_score: number;
	python_quality_score: number;
	final_score: number;
	gate_threshold: number;
	gate_decision: KnowledgeGateDecision;
	applicability: ApplicabilityState;
	missing_conditions: string[];
	quality_status: string;
}

export type KnowledgeTraceEvent =
	| "knowledge_retrieved"
	| "knowledge_evaluated"
	| "knowledge_used"
	| "knowledge_outcome";

/**
 * Identity of the knowledge-base snapshot a decision was made against.
 * Ablation runs must pin this: two runs reporting the same fingerprint read the
 * same cards, so a score difference is attributable to the agent rather than to
 * a silently rebuilt corpus.
 */
export interface KnowledgeBaseSnapshot {
	schema_version?: string;
	record_count?: number;
	card_fingerprint?: string;
}

export interface KnowledgeAuditEntry {
	timestamp: string;
	session_id: string;
	task_key_hash: string;
	turn: number;
	phase: string;
	evidence_revision: number;
	trigger: string;
	allowed: boolean;
	category: string;
	query_fingerprint: string;
	candidate_count: number;
	accepted_ids: string[];
	rejected_reasons: Array<{ id: string; reason: string }>;
	decision: string;
	latency_ms: number;
	error?: string;
	/** Decision-trace event; older readers may ignore it. */
	event?: KnowledgeTraceEvent;
	/** Per-card score breakdown for every evaluated candidate. */
	gate_scores?: GateAuditScore[];
	/** Card id for knowledge_used / knowledge_outcome events. */
	knowledge_id?: string;
	/** Event-specific detail (satisfied conditions, cost, outcome). */
	detail?: Record<string, unknown>;
	/** Effective knowledge-base switch at decision time, so an off-run is distinguishable from a run that searched and found nothing. */
	knowledge_base_enabled?: boolean;
	/** Identity of the corpus this decision was made against, for fixed-snapshot ablations. */
	knowledge_base_snapshot?: KnowledgeBaseSnapshot;
	/** Retrieval leg only (the legacy call); excludes gating and injection work. */
	retrieval_latency_ms?: number;
	/** Cards that were actually rendered into the model prompt. */
	injected_card_ids?: string[];
	/** Size of the rendered injection, i.e. the context budget this retrieval spent. */
	injected_characters?: number;
	/** Whether this decision changed the model context at all. */
	injected_into_context?: boolean;
}

// ============================================================================
// Deterministic alias and pattern tables
// ============================================================================

const TECHNIQUE_ALIASES: Readonly<Record<string, string>> = {
	uaf: "use-after-free",
	"use after free": "use-after-free",
	"double free": "double-free",
	sqli: "sql-injection",
	"sql injection": "sql-injection",
	xss: "cross-site-scripting",
	"cross site scripting": "cross-site-scripting",
	ssti: "server-side-template-injection",
	"template injection": "server-side-template-injection",
	ssrf: "server-side-request-forgery",
	"server side request forgery": "server-side-request-forgery",
	csrf: "cross-site-request-forgery",
	xxe: "xml-external-entity",
	rop: "return-oriented-programming",
	"return oriented programming": "return-oriented-programming",
	"got overwrite": "got-overwrite",
	"format string": "format-string",
	"heap overflow": "heap-overflow",
	"stack overflow": "stack-overflow",
	"buffer overflow": "buffer-overflow",
	"integer overflow": "integer-overflow",
	"off by one": "off-by-one",
	"padding oracle": "padding-oracle",
	"length extension": "length-extension",
	"nonce reuse": "nonce-reuse",
	"keystream reuse": "keystream-reuse",
	"common modulus": "common-modulus",
	"shared modulus": "shared-modulus",
	"small exponent": "small-exponent",
	"small e": "small-exponent",
	"cube root": "cube-root",
	"path traversal": "path-traversal",
	"directory traversal": "path-traversal",
	"command injection": "command-injection",
	"prototype pollution": "prototype-pollution",
	"insecure deserialization": "insecure-deserialization",
	"file upload": "file-upload",
	"request smuggling": "request-smuggling",
	"anti debugging": "anti-debug",
	"binary unpacking": "binary-unpacking",
};

const CATEGORY_ALIASES: Readonly<Record<string, AttackCategory>> = {
	web: "web",
	webapp: "web",
	"web-exploitation": "web",
	website: "web",
	http: "web",
	pwn: "pwn",
	binary: "pwn",
	"binary-exploitation": "pwn",
	exploitation: "pwn",
	crypto: "crypto",
	cryptography: "crypto",
	cryptanalysis: "crypto",
	reverse: "reverse",
	reversing: "reverse",
	rev: "reverse",
	"reverse-engineering": "reverse",
};

/** Attack techniques (English and Chinese). Used for explicit task recognition. */
export const ATTACK_TECHNIQUE_PATTERNS: readonly RegExp[] = [
	/\b(?:use[- ]after[- ]free|uaf|double[- ]free|tcache(?: poisoning)?|fastbin|unsorted bin)\b/iu,
	/\b(?:heap overflow|stack overflow|buffer overflow|integer overflow|off[- ]by[- ]one|format string)\b/iu,
	/\b(?:ret2libc|stack pivot|got overwrite|return[- ]oriented programming|rop chain|sigreturn|srop)\b/iu,
	/\b(?:sql injection|sqli|cross[- ]site scripting|xss|server[- ]side template injection|ssti)\b/iu,
	/\b(?:server[- ]side request forgery|ssrf|xxe|command injection|csrf|prototype pollution|path traversal)\b/iu,
	/\b(?:(?:(?:arbitrary|unrestricted) )?file upload|request smuggling|http request smuggling)\b/iu,
	/\b(?:padding oracle|length extension|nonce reuse|coppersmith|wiener(?:'s)? attack|franklin[- ]reiter)\b/iu,
	/\b(?:lattice attack|cbc bit flipping|prng prediction|jwt (?:forgery|confusion)|insecure deserialization)\b/iu,

	// Agents describe the primitive, not the attack name: source reads
	// "class LCG" and "mod/mult/add/seed" and never writes "prng prediction",
	// so a whole-phrase rule alone leaves the technique list empty.
	/\b(?:lcg|linear congruential|prng|prngs|state recovery|seed recovery|mt19937|mersenne twister)\b/iu,
	/\b(?:anti[- ]debugging|binary unpacking|crackme)\b/iu,
	/(?:\u91ca\u653e\u540e\u91cd\u7528|\u53cc\u91cd\u91ca\u653e|\u5806\u6ea2\u51fa|\u6808\u6ea2\u51fa|\u683c\u5f0f\u5316\u5b57\u7b26\u4e32|\u8fd4\u56de\u5bfc\u5411\u7f16\u7a0b)/u,
	/(?:SQL\s*\u6ce8\u5165|\u6a21\u677f\u6ce8\u5165|\u547d\u4ee4\u6ce8\u5165|\u8de8\u7ad9\u8bf7\u6c42\u4f2a\u9020|\u6587\u4ef6\u4e0a\u4f20)/iu,
	/(?:\u670d\u52a1\u7aef\u8bf7\u6c42\u4f2a\u9020|\u8bf7\u6c42\u8d70\u79c1|\u539f\u578b\u6c61\u67d3|\u8def\u5f84\u7a7f\u8d8a)/u,
	/(?:\u586b\u5145\u795e\u8c15|\u5bc6\u94a5\u6d41\u590d\u7528|\u968f\u673a\u6570\u9884\u6d4b)/u,
];

export const ATTACK_ACTION_PATTERN =
	/\b(?:exploit|pwn|attack(?![_ -]?memory)|bypass|decrypt|break|forge|recover|weaponize|reverse|factor|crack)\b|(?:\u5229\u7528|\u653b\u51fb|\u7834\u89e3|\u89e3\u5bc6|\u7ed5\u8fc7|\u4f2a\u9020|\u6062\u590d|\u9006\u5411|\u5206\u89e3)/iu;

export const ATTACK_DOMAIN_PATTERN =
	/\b(?:heap|binary|elf|shellcode|rsa|ecc|lattice|cipher|prng|web(?:site|app|service)?|jwt|template|deserialization|crackme)\b|(?:\u5806|\u4e8c\u8fdb\u5236|\u5bc6\u7801|\u683c(?:\u5bc6\u7801|\u653b\u51fb)|\u968f\u673a\u6570|\u7f51\u7ad9|\u7f51\u7edc\u670d\u52a1|\u53cd\u5e8f\u5217\u5316)/iu;

export const KNOWLEDGE_ROUTING_META_PATTERN =
	/\b(?:attack_memory_search|tool_search|attack memory|knowledge base|knowledge retrieval|runtime schema)\b|(?:\u77e5\u8bc6\u5e93|\u77e5\u8bc6\u83b7\u53d6|\u68c0\u7d22\u903b\u8f91|\u5de5\u5177\u8def\u7531)/iu;

/** Development-task negative gate: repository work is never a solve task. */
export const STRONG_DEVELOPMENT_TASK_PATTERN =
	/\b(?:repository|codebase|project|source code|implementation|implement|refactor|fix|regression|tests?|test suite|optimi[sz]e|configure|document|routing)\b|(?:\u4ed3\u5e93|\u9879\u76ee|\u4ee3\u7801\u5e93|\u6e90\u4ee3\u7801|\u5b9e\u73b0|\u91cd\u6784|\u4fee\u590d|\u56de\u5f52|\u4f18\u5316|\u6d4b\u8bd5|\u914d\u7f6e|\u6587\u6863|\u8def\u7531)/iu;

const RECON_PHASE_FACTS: readonly string[] = [
	"amd64",
	"aarch64",
	"i386",
	"mips",
	"riscv",
	"32-bit",
	"64-bit",
	"pie",
	"nx",
	"canary",
	"aslr",
	"relro",
	"full-relro",
	"partial-relro",
	"elf",
	"pe",
	"mach-o",
	"anti-debug",
	"verification-function",
	"input-constraints",
];

const EXPLOIT_PHASE_FACTS: readonly string[] = [
	"leak",
	"arbitrary-read",
	"arbitrary-write",
	"nonce-reuse",
	"keystream-reuse",
	"error-stack",
	"debug-mode",
];

const FAILURE_MARKERS: Readonly<Record<string, string>> = {
	"segmentation fault": "segfault",
	"core dumped": "crash",
	"connection refused": "connection-refused",
	"403 forbidden": "forbidden",
	"401 unauthorized": "unauthorized",
	"exploit failed": "exploit-failed",
	"bad allocation": "bad-alloc",
};

const MAX_FACTS_PER_CATEGORY = 24;
const MAX_EVIDENCE_FACTS = 40;
const MAX_EVIDENCE_TECHNIQUES = 16;
const MAX_FAILED_ROUTES = 8;
const MAX_OBJECTIVE_CHARS = 400;

const DEFAULT_MAX_INJECTED_CARDS = 3;
const DEFAULT_MAX_INJECTED_CHARACTERS = 10_000;
/** Floor that still fits one compact verification candidate block. */
const MIN_INJECTED_CHARACTERS = 240;
const DEFAULT_HARD_TIMEOUT_MS = 3_000;
/**
 * Budget for the first retrieval of a task.
 *
 * Category indexes load lazily in the Python host and the largest one needs
 * ~3.6s to parse, so the first call exceeds the steady budget and returns
 * nothing, losing the bootstrap retrieval meant to map the attack surface.
 * Later calls reuse the loaded index and finish well under a second.
 */
const FIRST_RETRIEVAL_TIMEOUT_MS = 8_000;
const RETRIEVAL_TOP_K = 20;
/** A timeout/error query may be retried this many times before it is parked. */
const MAX_QUERY_ATTEMPTS = 3;
/** Same-revision empty results become re-usable after this many turns. */
const EMPTY_QUERY_TTL_TURNS = 6;
/** Below this composite score even a needs_verification candidate is dropped. */
const GATE_SCORE_FLOOR = 0.4;
/** Verified-applicable cards still need a minimal composite score. */
const VERIFIED_ACCEPT_THRESHOLD = 0.55;
/**
 * A card whose preconditions could not be confirmed must clear this to be shown.
 *
 * Without it `needs_verification` was injectable and only changed how much of
 * the card got printed, so anything surviving the floor arrived as a "direction
 * to verify" and could steer the agent toward a technique the target does not
 * admit. Sits just under the observed median of real retrievals.
 */
const UNVERIFIED_INJECTION_FLOOR = 0.55;

// ============================================================================
// Helpers
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function stableTaskKeyHash(text: string): string {
	return createHash("sha256")
		.update(text.toLowerCase().replace(/\s+/gu, " ").trim(), "utf8")
		.digest("hex")
		.slice(0, 32);
}

function pushUnique(values: string[], next: readonly string[]): void {
	for (const value of next) {
		if (value && !values.includes(value)) values.push(value);
	}
}

export function aliasNormalize(value: string): string {
	const normalized = value.toLowerCase().trim().replace(/\s+/gu, " ");
	const direct = TECHNIQUE_ALIASES[normalized];
	if (direct) return direct;
	return normalized.replace(/\s+/gu, "-");
}

function aliasNormalizeAll(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => aliasNormalize(value)).filter(Boolean))];
}

function normalizedTokens(value: string): string[] {
	const lowered = value.toLowerCase();
	const latin = (lowered.match(/[a-z0-9_+#.-]+/gu) ?? [])
		.map((token) => token.replace(/^[._/-]+|[._/-]+$/gu, ""))
		.filter(Boolean);
	// Chinese challenges match in Python retrieval but produced no TS tokens
	// before, so their gate scores collapsed. Keep the whole run for exact
	// phrase hits plus overlapping bigrams for partial overlap.
	const cjk: string[] = [];
	for (const run of lowered.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/gu) ?? []) {
		cjk.push(run);
		if (run.length > 2) {
			for (let index = 0; index + 1 < run.length; index += 1) cjk.push(run.slice(index, index + 2));
		}
	}
	return [...new Set([...latin, ...cjk])];
}

export function normalizeAttackCategory(raw: string | undefined): AttackCategory | undefined {
	const value = (raw ?? "")
		.toLowerCase()
		.trim()
		.replace(/[\s-]+/gu, "-");
	if (!value) return undefined;
	return CATEGORY_ALIASES[value];
}

// ============================================================================
// Task recognition (SolveContextResolver)
// ============================================================================

/**
 * Fixed priority: competition envelope > task descriptor > explicit intent.
 * Anything else never triggers retrieval.
 */
export function resolveSolveTask(input: SolveContextInput): SolveKnowledgeTask | undefined {
	if (input.competition) {
		const category = normalizeAttackCategory(input.competition.category);
		if (!category) return undefined;
		const objective = [input.competition.name, input.competition.description]
			.filter((value) => value?.trim())
			.join(" - ")
			.slice(0, MAX_OBJECTIVE_CHARS);
		return {
			key: input.competition.taskId.trim() || stableTaskKeyHash(objective),
			source: "competition",
			solveMode: true,
			category,
			objective,
		};
	}
	if (input.descriptor && (input.descriptor.isCtf === true || input.descriptor.requiresVerification === true)) {
		return taskFromDescriptor(input.descriptor, input.prompt);
	}
	return resolveExplicitTask(input.prompt);
}

/** A verified challenge descriptor: the session, not the wording, says CTF. */
function taskFromDescriptor(descriptor: TaskDescriptorContext, prompt = ""): SolveKnowledgeTask {
	const text = descriptor.taskText ?? "";
	const objective = (descriptor.goal || text || prompt).slice(0, MAX_OBJECTIVE_CHARS);
	return {
		key: descriptor.targetId?.trim() || stableTaskKeyHash(text || prompt),
		source: "descriptor",
		solveMode: false,
		category: normalizeAttackCategory(descriptor.category),
		objective,
	};
}

/**
 * Explicit tasks need an attack action plus a concrete technique or domain.
 * A strong signal (action AND technique/domain) outranks the development and
 * routing-meta negative gates; a bare technique must pass them. Examples:
 * "find the flag" -> no, "fix SQL injection tests" -> no, "exploit this SQL
 * injection" -> yes.
 */
export function resolveExplicitTask(prompt: string): SolveKnowledgeTask | undefined {
	const normalized = prompt.replace(/\s+/gu, " ").trim();
	if (!normalized) return undefined;
	const technique = ATTACK_TECHNIQUE_PATTERNS.some((pattern) => pattern.test(normalized));
	const attackIntent = ATTACK_ACTION_PATTERN.test(normalized);
	const domain = ATTACK_DOMAIN_PATTERN.test(normalized);
	const strongSignal = attackIntent && (technique || domain);
	if (!strongSignal) {
		if (KNOWLEDGE_ROUTING_META_PATTERN.test(normalized) || STRONG_DEVELOPMENT_TASK_PATTERN.test(normalized)) {
			return undefined;
		}
		if (!technique) return undefined;
	}
	return {
		key: stableTaskKeyHash(normalized),
		source: "explicit",
		solveMode: false,
		category: inferCategoryFromText(normalized),
		objective: boundedObjective(normalized),
	};
}

/** Keep the attack-anchored window when the prompt exceeds the objective budget. */
function boundedObjective(normalized: string): string {
	if (normalized.length <= MAX_OBJECTIVE_CHARS) return normalized;
	const anchors = [...ATTACK_TECHNIQUE_PATTERNS, ATTACK_ACTION_PATTERN, ATTACK_DOMAIN_PATTERN]
		.map((pattern) => pattern.exec(normalized)?.index)
		.filter((index): index is number => index !== undefined);
	const anchor = anchors.length > 0 ? Math.max(...anchors) : 0;
	const start = Math.min(
		Math.max(0, anchor - Math.floor((MAX_OBJECTIVE_CHARS * 3) / 4)),
		normalized.length - MAX_OBJECTIVE_CHARS,
	);
	return normalized.slice(start, start + MAX_OBJECTIVE_CHARS);
}

const CATEGORY_SIGNALS: ReadonlyArray<{ category: AttackCategory; pattern: RegExp }> = [
	{
		category: "web",
		pattern:
			/\b(?:sql|injection|xss|ssti|ssrf|csrf|xxe|jwt|session|cookie|http|endpoint|route|template|deserial|request|url|form|upload|lfi|rfi|traversal|inclusion|login|auth)\w*\b/iu,
	},
	{
		category: "crypto",
		pattern:
			/\b(?:rsa|ecc|ecdsa|aes|des|sha\d*|hmac|md5|lattice|nonce|modulus|coppersmith|wiener|cipher|decrypt|factor|prime|padding)\w*\b/iu,
	},
	{
		category: "pwn",
		pattern:
			/\b(?:heap|stack|binary|elf|shellcode|rop|libc|glibc|pwntools|format string|use[- ]after[- ]free|double[- ]free|ret2|overflow|gdb)\w*\b/iu,
	},
	{
		category: "reverse",
		pattern: /\b(?:reverse|crackme|unpack|obfuscat|disassembl|decompil|check_flag|verify|serial|license)\w*\b/iu,
	},
];

function inferCategoryFromText(text: string): AttackCategory | undefined {
	let best: AttackCategory | undefined;
	let bestScore = 0;
	for (const { category, pattern } of CATEGORY_SIGNALS) {
		const score = pattern.test(text) ? 1 : 0;
		if (score > bestScore) {
			best = category;
			bestScore = score;
		}
	}
	return best;
}

/**
 * Category inference for lease objectives. The raw-signal table has overlap
 * hazards (e.g. web's `form\w*` matches "format string"), so this picks the
 * category whose extraction rules fire the most techniques on the text and
 * only falls back to the raw-signal table when no technique matches.
 */
function inferCategoryFromLeaseObjective(objective: string): AttackCategory | undefined {
	const sanitized = sanitizeToolText(objective);
	let best: AttackCategory | undefined;
	let bestCount = 0;
	for (const category of ATTACK_CATEGORIES) {
		const count = extractToolEvidence("lease_category", sanitized, category).techniques.length;
		if (count > bestCount) {
			best = category;
			bestCount = count;
		}
	}
	return bestCount > 0 ? best : inferCategoryFromText(sanitized);
}

// ============================================================================
// Evidence extraction (KnowledgeEvidenceExtractor)
// ============================================================================

/** Strip secrets before any normalization: flags, tokens, cookies, and credentials never become facts. */
export function sanitizeToolText(text: string): string {
	let value = text;
	value = value.replace(/\b(?:ctf|flag)\{[^}\n]{2,}\}/giu, "[redacted-flag]");
	value = value.replace(
		/\b(session(?:id)?|token|jwt|authorization|bearer|api[_-]?key|password|secret|cookie)\b\s*[:=]\s*\S+/giu,
		"$1=[redacted]",
	);
	return value;
}

interface ExtractionRule {
	pattern: RegExp;
	fact?: string;
	technique?: string;
	format?: (match: RegExpMatchArray) => string;
}

const COUNT_WORDS: Readonly<Record<string, number>> = {
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
};

/** Tool output mixes digits and spelled-out counts ("two ciphertexts"). */
function countValue(raw: string | undefined): number {
	const value = (raw ?? "").toLowerCase();
	return COUNT_WORDS[value] ?? (Number.parseInt(value, 10) || 0);
}

const SHARED_BINARY_RULES: readonly ExtractionRule[] = [
	{ pattern: /\b(x86[_-]?64|amd64|x64)\b/iu, fact: "amd64" },
	{ pattern: /\b(aarch64|arm64)\b/iu, fact: "aarch64" },
	{ pattern: /\bi?[3-6]86\b/iu, fact: "i386" },
	{ pattern: /\b(mips(?:el|64)?)\b/iu, fact: "mips" },
	{ pattern: /\b(risc-?v(?:64)?|riscv64)\b/iu, fact: "riscv" },
	{ pattern: /\b64[- ]?bit\b/iu, fact: "64-bit" },
	{ pattern: /\b32[- ]?bit\b/iu, fact: "32-bit" },
	{ pattern: /\bno[- ]pie\b|\bpie\s+(?:is\s+)?(?:disabled|off|not\s+enabled)\b/iu, fact: "no-pie" },
	{ pattern: /(?<!no[-\s])\bpie\b(?!\s+(?:is\s+)?(?:disabled|off|not\s+enabled))/iu, fact: "pie" },
	{ pattern: /\bno[- ]nx\b|\bnx\s+(?:is\s+)?(?:disabled|off)\b/iu, fact: "no-nx" },
	{ pattern: /(?<!no[-\s])\bnx\b(?!\s+(?:is\s+)?(?:disabled|off))/iu, fact: "nx" },
	{ pattern: /\baslr\s*[:=]\s*(off|disabled)\b/iu, fact: "no-aslr" },
	{ pattern: /\baslr\s*[:=]\s*(on|enabled)\b/iu, fact: "aslr" },
	{ pattern: /\bno[- ]canary\b|\bcanary\s+(?:is\s+)?(?:absent|disabled|not\s+found)\b/iu, fact: "no-canary" },
	{ pattern: /(?<!no[-\s])\b(?:stack\s+)?canary\b(?!\s+(?:is\s+)?(?:absent|disabled|not\s+found))/iu, fact: "canary" },
	{ pattern: /\bfull\s+relro\b/iu, fact: "full-relro" },
	{ pattern: /\bpartial\s+relro\b/iu, fact: "partial-relro" },
	{ pattern: /\bno\s+relro\b/iu, fact: "no-relro" },
	{ pattern: /(?<!no[-\s])\brelro\b(?!\s+(?:is\s+)?disabled)/iu, fact: "relro" },
	{ pattern: /\b(?:glibc|libc)[\s_-]*v?(\d+\.\d+(?:\.\d+)?)\b/iu, format: (match) => `glibc-${match[1].trim()}` },
	{
		pattern: /\b(ptmalloc|dlmalloc|jemalloc|tcmalloc|musl)\b/iu,
		format: (match) => `allocator:${match[1].toLowerCase()}`,
	},
];

const PWN_RULES: readonly ExtractionRule[] = [
	...SHARED_BINARY_RULES,
	{ pattern: /\b(?:info|address|memory)[ -]?leak\b|\bleak\b/iu, fact: "leak" },
	{ pattern: /\barbitrary\s+(read|write)\b/iu, format: (match) => `arbitrary-${match[1].toLowerCase()}` },
	{ pattern: /\bwrite[- ]what[- ]where\b/iu, fact: "arbitrary-write" },
	{ pattern: /\buse[- ]after[- ]free\b|\buaf\b/iu, technique: "use-after-free" },
	{ pattern: /\bdouble[- ]free\b/iu, technique: "double-free" },
	{ pattern: /\btcache\s+poisoning\b/iu, technique: "tcache-poisoning" },
	{ pattern: /\bfastbin\s+attack\b|\bfastbin\b/iu, technique: "fastbin-attack" },
	{ pattern: /\bunsorted\s+bin\s+attack\b/iu, technique: "unsorted-bin-attack" },
	{ pattern: /\bheap\s+overflow\b/iu, technique: "heap-overflow" },
	{ pattern: /\bstack\s+overflow\b|\bbuffer\s+overflow\b/iu, technique: "stack-overflow" },
	{ pattern: /\binteger\s+overflow\b/iu, technique: "integer-overflow" },
	{ pattern: /\boff[- ]by[- ]one\b/iu, technique: "off-by-one" },
	{ pattern: /\bformat[- ]string\b/iu, technique: "format-string" },
	{ pattern: /\bret2libc\b/iu, technique: "ret2libc" },
	{ pattern: /\bstack\s+pivot\b/iu, technique: "stack-pivot" },
	{ pattern: /\bgot\s+overwrite\b|\bgot\s+hijack\b/iu, technique: "got-overwrite" },
	{ pattern: /\b(?:return[- ]oriented\s+programming|\brop\b)/iu, technique: "return-oriented-programming" },
	{ pattern: /\b(sigreturn|srop)\b/iu, technique: "sigreturn" },
];

const WEB_RULES: readonly ExtractionRule[] = [
	{
		pattern:
			/\b(flask|django|fastapi|express(?:\.js)?|spring(?:[\s-]boot)?|laravel|rails|php|asp\.net|node(?:\.js)?|next\.js|nuxt)\b/iu,
		format: (match) => `framework:${match[1].toLowerCase().replace(/\s+/gu, "-")}`,
	},
	{ pattern: /\b(?:route|endpoint|path|url)\s*[:=]\s*(\/[^\s"'`,;]+)/giu, format: (match) => `route:${match[1]}` },
	{
		pattern: /\b(?:param(?:eter)?|query|field|input|key)\s*[:=]\s*([a-zA-Z_][\w-]{0,40})/giu,
		format: (match) => `param:${match[1]}`,
	},
	{ pattern: /\b(?:json[ -]web[ -]token|jwt)\b/iu, fact: "jwt" },
	{
		pattern: /\b(?:bearer[ -]token|session[ -]cookie|basic[ -]auth|oauth2?)\b/iu,
		format: (match) => `auth:${match[0].toLowerCase().replace(/\s+/gu, "-")}`,
	},
	{ pattern: /\b(?:stack[ -]trace|traceback)\b/iu, fact: "error-stack" },
	{ pattern: /\bdebug[ -]mode\b/iu, fact: "debug-mode" },
	{ pattern: /\binternal[ -]server[ -]error\b/iu, fact: "internal-server-error" },
	{
		pattern: /\bsql\s+(?:injection|error)|sqlite error|\bmysql\b|\bpostgresql\b|ora-\d{4,5}\b/iu,
		technique: "sql-injection",
	},
	{ pattern: /\bcross[- ]site\s+scripting\b|\bxss\b/iu, technique: "cross-site-scripting" },
	{
		pattern: /\bserver[- ]side\s+template\s+injection\b|\bssti\b|\{\{[\w.()|]+\}\}|\$\{[\w.()|]+\}|<%[\s\S]{1,60}%>/u,
		technique: "server-side-template-injection",
	},
	{ pattern: /\bserver[- ]side\s+request\s+forgery\b|\bssrf\b/iu, technique: "server-side-request-forgery" },
	{ pattern: /\bcsrf\b/iu, technique: "cross-site-request-forgery" },
	{ pattern: /\bxxe\b|xml[ -]external[ -]entity/iu, technique: "xml-external-entity" },
	{ pattern: /\bcommand\s+injection\b|\bos\s+command\b/iu, technique: "command-injection" },
	{
		pattern: /\bpath\s+traversal\b|\bdirectory\s+traversal\b|(?:^|\s)\.\.\/(?:[a-z]|$)/iu,
		technique: "path-traversal",
	},
	{ pattern: /\b(?:local|remote)\s+file\s+inclusion\b|\blfi\b|\brfi\b/iu, technique: "file-inclusion" },
	{
		pattern: /\b(?:insecure\s+)?deserialization\b|\bpickle\b|\byaml\.load\b/iu,
		technique: "insecure-deserialization",
	},
	{ pattern: /\bprototype\s+pollution\b/iu, technique: "prototype-pollution" },
	{ pattern: /\bfile\s+upload\b/iu, technique: "file-upload" },
	{ pattern: /\brequest\s+smuggling\b/iu, technique: "request-smuggling" },
	{ pattern: /\bopen\s+redirect\b/iu, technique: "open-redirect" },
	{ pattern: /\b(?:insecure\s+direct\s+object\s+reference|\bidor\b)/iu, technique: "idor" },
];

const CRYPTO_RULES: readonly ExtractionRule[] = [
	// Whole-phrase rules miss LCG challenges: the corpus tags this family
	// PRNG / prng-state-recovery / seed-space / mt19937-state-recovery, and
	// the agent writes the primitive (lcg, mod/mult/add/seed) instead.
	{ pattern: /\b(?:lcg|linear\s+congruential)\b|线性同余/iu, technique: "prng-state-recovery" },
	{ pattern: /\bprng\b|伪随机/iu, technique: "prng-state-recovery" },
	{
		pattern: /\b(?:seed\s+(?:space|brute[- ]?force)|recover(?:ing)?\s+the\s+seed)\b|种子空间/iu,
		technique: "seed-space",
	},
	{ pattern: /\bmt19937\b|梅森/iu, technique: "mt19937-state-recovery" },
	{ pattern: /\bRSA\b/u, fact: "rsa" },
	{ pattern: /\bECC\b/u, fact: "ecc" },
	{ pattern: /\bECDSA\b/u, fact: "ecdsa" },
	{ pattern: /\bAES(?:-?(?:128|192|256))?\b/iu, fact: "aes" },
	{ pattern: /\b(?:3DES|DES)\b/u, fact: "des" },
	{ pattern: /\bRC4\b/iu, fact: "rc4" },
	{ pattern: /\bSHA(?:-)?(1|224|256|384|512)?\b/iu, format: (match) => `sha${match[1] ?? "256"}` },
	{ pattern: /\bMD5\b/iu, fact: "md5" },
	{ pattern: /\bHMAC\b/iu, fact: "hmac" },
	{ pattern: /\bED25519\b/iu, fact: "ed25519" },
	{
		pattern: /\b(?:modulus|key|n)\s*(?:is|of|:|=)?\s*(\d{2,5})\s*(?:bits?|-bit)\b/iu,
		format: (match) => `modulus-bits=${match[1]}`,
	},
	{ pattern: /\b(\d{2,5})[- ]?bit\s+(?:rsa\s+)?(?:modulus|key|n)\b/iu, format: (match) => `modulus-bits=${match[1]}` },
	{ pattern: /\be\s*=\s*(\d{1,12})\b/iu, format: (match) => `e=${match[1]}` },
	{ pattern: /\bpublic\s+exponent\s*(?:is|of|=)?\s*(\d{1,12})\b/iu, format: (match) => `e=${match[1]}` },
	{
		pattern:
			/\b(\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:ciphertexts?|plaintexts?|samples?|pairs?|signatures?|messages?|outputs?)\b/iu,
		format: (match) => `samples=${countValue(match[1])}`,
	},
	{ pattern: /\bnonce\s+(?:reuse|reused|repeated|repetition)\b/iu, fact: "nonce-reuse" },
	{ pattern: /\bkeystream\s+reuse\b/iu, fact: "keystream-reuse" },
	{
		pattern: /\b(?:common|shared)\s+(?:modulus|prime)\b/iu,
		format: (match) => `${match[0].toLowerCase().replace(/\s+/gu, "-")}`,
	},
	{ pattern: /\bpadding\s+oracle\b/iu, technique: "padding-oracle" },
	{ pattern: /\blength\s+extension\b/iu, technique: "length-extension" },
	{ pattern: /\bcoppersmith\b/iu, technique: "coppersmith" },
	{ pattern: /\bwiener(?:'s)?\s+attack\b/iu, technique: "wiener-attack" },
	{ pattern: /\bhastad(?:'s)?\s+broadcast\b/iu, technique: "hastad-broadcast" },
	{ pattern: /\bfranklin[- ]reiter\b/iu, technique: "franklin-reiter" },
	{ pattern: /\blattice\s+attack\b|\blll\b/iu, technique: "lattice-attack" },
	{ pattern: /\bcbc\s+bit[ -]flipping\b/iu, technique: "cbc-bit-flipping" },
	{ pattern: /\bsmooth\s+order\b|\bpohlig[ -]hellman\b/iu, technique: "pohlig-hellman" },
];

const REVERSE_RULES: readonly ExtractionRule[] = [
	{ pattern: /\bELF\b/u, fact: "elf" },
	{ pattern: /\bPE32\+?\b|\bPE64\b/u, fact: "pe" },
	{ pattern: /\bMach-O\b/iu, fact: "mach-o" },
	...SHARED_BINARY_RULES,
	{
		pattern: /\b(UPX|ASPack|Themida|VMProtect|MPRESS|Petite)\b/iu,
		format: (match) => `packer:${match[1].toLowerCase()}`,
	},
	{
		pattern: /\b(?:anti[- ]?debug(?:ging)?|ptrace|isDebuggerPresent|debugger|anti[- ]?analysis)\b/iu,
		fact: "anti-debug",
	},
	{ pattern: /\b(?:check|verify|validate|is_valid)_?\w{0,20}\b/iu, fact: "verification-function" },
	{ pattern: /\b(?:checksum|crc32?|md5)\s+(?:check|verify|validat)\w*\b/iu, fact: "checksum-check" },
	{
		pattern:
			/\b(?:input|password|serial|license)[ -]?(?:key)?\s+(?:must|should|is|requires?|length|format|max|min)\b/iu,
		fact: "input-constraints",
	},
];

const CATEGORY_RULES: Readonly<Record<AttackCategory, readonly ExtractionRule[]>> = {
	pwn: PWN_RULES,
	web: WEB_RULES,
	crypto: CRYPTO_RULES,
	reverse: REVERSE_RULES,
};

/**
 * Extract normalized security facts from tool results. Full tool output, flags,
 * tokens, and target secrets are never stored — only canonical fact strings.
 */
export function extractToolEvidence(toolName: string, text: string, category?: AttackCategory): ExtractedEvidence {
	const facts: string[] = [];
	const techniques: string[] = [];
	for (const rules of category ? [CATEGORY_RULES[category]] : Object.values(CATEGORY_RULES)) {
		for (const rule of rules) {
			// matchAll requires the global flag; the shared rule patterns are
			// deliberately non-global so .test() stays stateless, so build a
			// global copy purely for multi-match extraction here.
			const pattern = rule.pattern.global ? rule.pattern : new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
			const matches = [...text.matchAll(pattern)].slice(0, 4);
			for (const match of matches) {
				const value = rule.fact ?? rule.format?.(match) ?? "";
				if (rule.technique && !techniques.includes(rule.technique)) techniques.push(rule.technique);
				if (value && !facts.includes(value)) facts.push(value);
			}
			if (facts.length >= MAX_FACTS_PER_CATEGORY) break;
		}
		if (facts.length >= MAX_FACTS_PER_CATEGORY) break;
	}
	const phase = inferPhase(facts, techniques);
	const failedRoute = inferFailedRoute(text, toolName, techniques, facts);
	return {
		facts: facts.slice(0, MAX_FACTS_PER_CATEGORY),
		techniques: techniques.slice(0, MAX_EVIDENCE_TECHNIQUES),
		phase,
		failedRoute,
	};
}

function inferPhase(facts: readonly string[], techniques: readonly string[]): string | undefined {
	if (techniques.length > 0 || facts.some((fact) => EXPLOIT_PHASE_FACTS.includes(fact))) return "exploit";
	if (facts.some((fact) => RECON_PHASE_FACTS.includes(fact))) return "recon";
	return undefined;
}

function inferFailedRoute(
	text: string,
	toolName: string,
	techniques: readonly string[],
	facts: readonly string[],
): string | undefined {
	const lower = text.toLowerCase();
	for (const [marker, canonical] of Object.entries(FAILURE_MARKERS)) {
		if (!lower.includes(marker)) continue;
		const context = techniques[0] ?? facts.find((fact) => fact.includes(":")) ?? "generic";
		return `${toolName}:${context}:${canonical}`.slice(0, 200);
	}
	return undefined;
}

// ============================================================================
// Query generation and fingerprints
// ============================================================================

const NEED_BY_TRIGGER: Readonly<Record<RetrievalTrigger, readonly string[]>> = {
	task_bootstrap: ["recognition signals", "common attack families", "prerequisite collection"],
	evidence_refinement: ["compatible exploit path", "prerequisite checks", "failure modes"],
	stall_recovery: ["failure modes", "alternative routes"],
	// Model-initiated searches carry the model's own query text and never go
	// through buildKnowledgeQuerySpec; the empty row keeps the table total.
	manual_tool: [],
};

export function buildKnowledgeQuerySpec(
	task: SolveKnowledgeTask,
	evidence: SolveKnowledgeEvidence,
	trigger: RetrievalTrigger,
): KnowledgeQuerySpec {
	return {
		category: task.category,
		phase: evidence.phase || "recon",
		objective: task.objective.toLowerCase().replace(/\s+/gu, " ").trim(),
		techniques: aliasNormalizeAll(evidence.techniques.slice(0, 8)),
		facts: aliasNormalizeAll(evidence.targetFacts.slice(0, 16)),
		failedRoutes: aliasNormalizeAll(evidence.failedRoutes.slice(0, 4)),
		need: [...NEED_BY_TRIGGER[trigger]],
	};
}

/** Canonical JSON with stable field order and sorted arrays; the fingerprint input. */
export function canonicalQueryJson(spec: KnowledgeQuerySpec): string {
	// Alias-normalize here as well as in buildKnowledgeQuerySpec: fingerprints
	// must be stable for hand-built specs too (verifiers, tests, refinements),
	// otherwise "SQL Injection" and "sql-injection" produce different queries.
	return JSON.stringify({
		category: spec.category ?? "",
		phase: spec.phase,
		objective: spec.objective,
		techniques: aliasNormalizeAll(spec.techniques).sort(),
		facts: aliasNormalizeAll(spec.facts).sort(),
		failed_routes: aliasNormalizeAll(spec.failedRoutes).sort(),
		need: [...spec.need].sort(),
	});
}

export function queryFingerprint(spec: KnowledgeQuerySpec): string {
	return createHash("sha256").update(canonicalQueryJson(spec), "utf8").digest("hex");
}

export function formatQuery(spec: KnowledgeQuerySpec): string {
	// The field names ("objective=", "facts=", ...) are pure noise for a lexical
	// ranker. The `need` phrases are kept: at bootstrap the objective is the
	// challenge description and the evidence is still empty, so those intents are
	// the only thing telling the ranker what kind of knowledge the task needs.
	const parts = [
		...(spec.category ? [spec.category] : []),
		spec.objective,
		...spec.techniques,
		...spec.facts,
		...spec.failedRoutes,
		...spec.need,
	];
	return parts
		.map((part) => part.replace(/\s+/gu, " ").trim())
		.filter(Boolean)
		.join(" ");
}

// ============================================================================
// Planning-executor lease parsing
// ============================================================================

/**
 * Read-only anchor on the first line that planning/context.ts renders for
 * leased executor tasks. This module never writes into the planning runtime;
 * it only recognizes the rendered executor context to decide when a
 * fine-grained, execution-focused retrieval should run.
 */
const PLANNING_EXECUTOR_CONTEXT_MARKER = "You are executing exactly one leased task in a progressive plan.";

/** Fine-grained needs for execution-time retrieval; planning keeps strategy-level needs. */
const LEASE_NEEDS: readonly string[] = ["exploit steps", "canonical poc", "prerequisite checks", "failure modes"];

export interface PlanningLeaseSignals {
	objective: string;
	doneWhen: string;
}

function jsonUnescape(raw: string): string {
	try {
		return JSON.parse(`"${raw}"`) as string;
	} catch {
		return raw;
	}
}

function extractLeaseFromJson(prompt: string): PlanningLeaseSignals | undefined {
	const jsonStart = prompt.indexOf("{");
	if (jsonStart < 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(prompt.slice(jsonStart));
		if (!isRecord(parsed) || !isRecord(parsed.task)) return undefined;
		const task = parsed.task;
		const objective = typeof task.objective === "string" ? task.objective : "";
		if (!objective.trim()) return undefined;
		return {
			objective,
			doneWhen: typeof task.doneWhen === "string" ? task.doneWhen : "",
		};
	} catch {
		return undefined;
	}
}

function extractLeaseFromRegex(prompt: string): PlanningLeaseSignals | undefined {
	// The lease ("task") precedes executionFrame.taskSummaries in the rendered
	// key order, so anchoring at the first "task" key picks the lease objective.
	const taskKey = prompt.indexOf('"task"');
	const searchFrom = taskKey >= 0 ? taskKey : 0;
	const body = prompt.slice(searchFrom);
	const objective = /"objective"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(body);
	if (!objective) return undefined;
	const doneWhen = /"doneWhen"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(body);
	return {
		objective: jsonUnescape(objective[1]),
		doneWhen: doneWhen ? jsonUnescape(doneWhen[1]) : "",
	};
}

/**
 * Extract lease signals from a rendered planning-executor context. Returns
 * undefined for any other prompt, including supervisor and parent sessions.
 * Truncated contexts fall back to regex extraction because
 * renderPlanningContext may cut the embedded JSON at the evidence budget.
 */
export function parsePlanningLeaseSignals(prompt: string): PlanningLeaseSignals | undefined {
	if (!prompt.includes(PLANNING_EXECUTOR_CONTEXT_MARKER)) return undefined;
	return extractLeaseFromJson(prompt) ?? extractLeaseFromRegex(prompt);
}

// ============================================================================
// Candidate parsing (AttackKnowledgeClient)
// ============================================================================

function stringArray(value: unknown, limit: number): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string").slice(0, limit);
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function finiteScore(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Pull the corpus identity the legacy retrieval host reports back. Absent or
 * malformed metadata yields undefined rather than a placeholder: an unknown
 * snapshot must not read like a known one.
 */
export function parseKnowledgeBaseSnapshot(data: unknown): KnowledgeBaseSnapshot | undefined {
	if (!isRecord(data)) return undefined;
	const block = data.knowledge_base;
	if (!isRecord(block)) return undefined;
	const schemaVersion = stringValue(block.schema_version ?? block.schemaVersion);
	const fingerprint = stringValue(block.card_fingerprint ?? block.cardFingerprint);
	const recordCount = Number(block.record_count ?? block.recordCount);
	if (!schemaVersion && !fingerprint && !Number.isSafeInteger(recordCount)) return undefined;
	return {
		...(schemaVersion ? { schema_version: schemaVersion } : {}),
		...(Number.isSafeInteger(recordCount) ? { record_count: recordCount } : {}),
		...(fingerprint ? { card_fingerprint: fingerprint } : {}),
	};
}

export function parseKnowledgeCandidates(data: unknown): KnowledgeCardHit[] {
	if (!isRecord(data)) return [];
	const packet = data.knowledge_packet ?? data.matches ?? data.candidates ?? data.data;
	if (!Array.isArray(packet)) return [];
	return packet.flatMap((entry) => {
		if (!isRecord(entry)) return [];
		const recordId = stringValue(entry.record_id);
		if (!recordId) return [];
		const sourceUrls = stringArray(entry.source_urls ?? [entry.source_url], 5).filter(Boolean);
		// The Python layer already ran recall, relevance scoring, and data
		// quality checks; carry its annotation through instead of recomputing an
		// independent accept/reject standard on this side.
		const quality = isRecord(entry.quality) ? entry.quality : {};
		return [
			{
				recordId,
				category: stringValue(entry.category).toLowerCase(),
				kind: stringValue(entry.kind),
				score: finiteScore(entry.score),
				challenge: stringValue(entry.challenge),
				label: stringValue(entry.label),
				attackPatterns: stringArray(entry.attack_pattern, 8),
				whyMatched: stringValue(entry.why_matched),
				recognitionSignals: stringArray(entry.recognition_signals, 12),
				preconditions: stringArray(entry.preconditions, 8),
				attackSteps: stringArray(entry.attack_steps, 10),
				poc: stringValue(entry.poc),
				canonicalPoc: stringValue(entry.canonical_poc),
				failureModes: stringArray(entry.failure_modes, 6),
				sourceUrls,
				reviewStatus: stringValue(entry.review_status),
				verificationStatus: stringValue(entry.verification_status),
				qualityStatus: stringValue(entry.quality_status) || stringValue(quality.status),
				qualityScore: finiteScore(entry.quality_score ?? quality.score),
				qualityReasons: [...stringArray(quality.reasons, 8), ...stringArray(entry.quality_reasons, 8)],
			},
		];
	});
}

// ============================================================================
// Quality gate (KnowledgeQualityGate)
// ============================================================================

export interface GateOptions {
	category?: AttackCategory;
	evidence: SolveKnowledgeEvidence;
	injectedCardIds: readonly string[];
	/** Raw retrieval scores of all candidates in ranked order. Computed from the matches when omitted. */
	rankedScores?: readonly number[];
	/** Task objective text; the taxonomy signal for bootstrap queries without extracted techniques. */
	objective?: string;
	trigger?: RetrievalTrigger;
	/** Card IDs already proven inapplicable for this task; never re-offered. */
	contradictedCardIds?: readonly string[];
}

interface MitigationConflict {
	fact: string;
	conflict: RegExp;
}

const MITIGATION_CONFLICTS: readonly MitigationConflict[] = [
	{ fact: "pie", conflict: /\bno\s+pie\b|\bnon[- ]pie\b|\bpie\s+disabled\b/iu },
	{ fact: "no-pie", conflict: /\bpie\s+(?:enabled|required|on)\b|\brequires?\s+pie\b/iu },
	{ fact: "nx", conflict: /\bno\s+nx\b|\bnx\s+disabled\b/iu },
	{ fact: "no-nx", conflict: /\bnx\s+(?:enabled|required|on)\b/iu },
	{ fact: "canary", conflict: /\bno\s+canary\b|\bcanary\s+disabled\b/iu },
	{ fact: "no-canary", conflict: /\bcanary\s+(?:enabled|required|present)\b/iu },
	{ fact: "aslr", conflict: /\bno\s+aslr\b|\baslr\s+disabled\b/iu },
	{ fact: "no-aslr", conflict: /\baslr\s+(?:enabled|required|on)\b/iu },
	{ fact: "full-relro", conflict: /\bno\s+relro\b|\bpartial\s+relro\b/iu },
	{ fact: "partial-relro", conflict: /\bfull\s+relro\b/iu },
];

function candidateText(match: KnowledgeCardHit): string {
	return [
		match.challenge,
		match.label,
		...match.preconditions,
		...match.attackSteps,
		...match.failureModes,
		...match.recognitionSignals,
	].join(" ");
}

function findPrerequisiteConflicts(match: KnowledgeCardHit, facts: readonly string[]): string[] {
	const conflicts: string[] = [];
	const factAliases = aliasNormalizeAll(facts);
	for (const precondition of match.preconditions) {
		for (const { fact, conflict } of MITIGATION_CONFLICTS) {
			if (factAliases.includes(fact) && conflict.test(precondition)) {
				conflicts.push(`precondition_conflicts_with_${fact}`);
			}
		}
		const versionMatch = /glibc[\s_-]*[<>=~]*\s*v?(\d+\.\d+)/iu.exec(precondition);
		if (versionMatch) {
			const required = versionMatch[1];
			const known = facts.find((fact) => fact.startsWith("glibc-") && fact.slice("glibc-".length) !== required);
			if (known) conflicts.push("glibc_version_mismatch");
		}
	}
	return [...new Set(conflicts)];
}

/**
 * Split hyphen/underscore/dot compounds so a normalized label
 * (`sql-injection`) still matches spaced evidence text (`sql injection`).
 * Without this, every alias-normalized pattern token failed to match the
 * space-split objective tokens and bootstrap taxonomy scores collapsed to 0.
 */
function compoundParts(token: string): string[] {
	return token.split(/[-_.]/u).filter((part) => part.length > 0);
}

function expandedTokens(value: string): string[] {
	return [...new Set(normalizedTokens(value).flatMap((token) => [token, ...compoundParts(token)]))];
}

/** Reduce tokens to their word parts so compound labels compare by content. */
function baseTokens(tokens: readonly string[]): string[] {
	return [...new Set(tokens.flatMap((token) => compoundParts(token)))];
}

function tokenOverlapScore(patterns: readonly string[], wantedTokens: readonly string[]): number {
	const wanted = new Set(baseTokens(wantedTokens));
	if (wanted.size === 0) return 0;
	for (const pattern of patterns) {
		const patternTokens = baseTokens(expandedTokens(pattern));
		if (patternTokens.length === 0) continue;
		const overlap = patternTokens.filter((token) => wanted.has(token)).length;
		if (overlap === patternTokens.length) return 1;
		if (overlap >= Math.ceil(patternTokens.length / 2)) return 0.6;
	}
	return 0;
}

/**
 * Alias expansion is one-way today: `csrf` collapses to
 * `cross-site-request-forgery`, so a card labelled with the long form can no
 * longer match a prompt that only says "CSRF". Add the canonical form of every
 * known alias so both spellings meet in the middle.
 */
function withCanonicalAliases(tokens: readonly string[]): string[] {
	const expanded = [...tokens];
	for (const token of tokens) {
		const canonical = TECHNIQUE_ALIASES[token];
		if (canonical) expanded.push(canonical);
	}
	return expanded;
}

function taxonomyMatchScore(match: KnowledgeCardHit, techniques: readonly string[], objective: string): number {
	const patterns = aliasNormalizeAll([...match.attackPatterns, match.label, ...match.recognitionSignals.slice(0, 4)]);
	if (patterns.length === 0) return 0;
	const wanted = aliasNormalizeAll(techniques);
	if (wanted.some((technique) => patterns.includes(technique))) return 1;
	if (wanted.length > 0) {
		const wantedTokens = wanted.flatMap((technique) => normalizedTokens(technique));
		const techniqueScore = tokenOverlapScore(patterns, wantedTokens);
		if (techniqueScore > 0) return techniqueScore;
	}
	// Objective fallback: bootstrap and stall queries may have no extracted
	// techniques yet, so the task text is the taxonomy signal.
	const objectiveScore = objective.trim()
		? tokenOverlapScore(patterns, withCanonicalAliases(normalizedTokens(objective)))
		: 0;
	return objectiveScore;
}

function evidenceOverlapScore(match: KnowledgeCardHit, facts: readonly string[]): number {
	if (facts.length === 0) return 0;
	const candidateTokens = new Set(normalizedTokens(candidateText(match)));
	const matched = facts.filter((fact) => normalizedTokens(fact).some((token) => candidateTokens.has(token))).length;
	return matched / facts.length;
}

function prerequisiteFitScore(satisfied: number, total: number): number {
	// No declared preconditions means the term cannot be evaluated, not that the
	// card fails it. Every record in the current corpus omits the field, so a
	// penalty here shifts the whole distribution down uniformly, carries no
	// ranking information, and leaves nothing able to clear the gate at all.
	// A card that declares no preconditions is *unknown*, not satisfied: the old
	// `return 1` handed generic cards a free full score and let them outrank
	// cards whose conditions were merely not yet confirmed.
	if (total === 0) return 0.5;
	return satisfied / total;
}

function provenanceScore(match: KnowledgeCardHit): number {
	return match.sourceUrls.length > 0 ? 1 : 0;
}

/**
 * Vocabulary signature of a card, used to recognise near-duplicates.
 *
 * The corpus labels some rows cleanly ("rsa wiener small d") and leaves whole
 * method steps in the label field for others, so an exact family key cannot tell
 * two restatements of one technique from two different techniques.
 */
function injectionFamilyTokens(match: KnowledgeCardHit): Set<string> {
	const labels = aliasNormalizeAll([...match.attackPatterns, match.label]);
	const usable = labels.find((label) => label.length > 0 && label.split(" ").length <= 4);
	if (usable) return new Set(usable.split(" "));
	return new Set(
		normalizedTokens([...match.recognitionSignals, ...match.attackSteps].slice(0, 6).join(" ")).filter(
			(token) => token.length > 3,
		),
	);
}

/**
 * True when two cards teach the same thing.
 *
 * Measured on real retrievals: three cards carrying the same attack family
 * score 0.8-1.0 against each other, while a genuinely different technique on the
 * same challenge scores 0.07-0.11.
 */
function isSameInjectionFamily(left: KnowledgeCardHit, right: KnowledgeCardHit): boolean {
	const a = injectionFamilyTokens(left);
	const b = injectionFamilyTokens(right);
	if (a.size === 0 || b.size === 0) return false;
	let shared = 0;
	for (const token of a) if (b.has(token)) shared += 1;
	const union = a.size + b.size - shared;
	return union > 0 && shared / union >= 0.5;
}

function marginScore(score: number, rankedScores: readonly number[]): number {
	// The previous form measured the gap to the runner-up, which is 1 for the
	// leader and 0 for everything behind it: twenty candidates collapsed onto two
	// values. Measuring against the leader keeps the ordering the query produced.
	if (rankedScores.length === 0) return 0;
	if (rankedScores.length === 1) return 1;
	const top = Math.max(rankedScores[0], 0.0001);
	return Math.min(1, Math.max(0, score / top));
}

function pythonQualityScore(match: KnowledgeCardHit): number {
	const annotated = match.qualityScore ?? 0;
	if (annotated > 0) return Math.min(1, annotated);
	const status = (match.qualityStatus ?? "").toLowerCase();
	if (status === "accepted") return 0.75;
	if (status === "ambiguous") return 0.45;
	return 0.4;
}

export interface ApplicabilityAssessment {
	state: ApplicabilityState;
	satisfiedPreconditions: string[];
	missingPreconditions: string[];
	contradictions: string[];
}

/**
 * Deterministic three-state applicability. This replaces the single weighted
 * score as the adopt/verify/reject authority: the score still ranks candidates
 * and feeds the audit trace, but never decides on its own whether a method may
 * be executed.
 */
export function assessApplicability(
	match: KnowledgeCardHit,
	evidence: SolveKnowledgeEvidence,
): ApplicabilityAssessment {
	const facts = evidence.targetFacts;
	const contradictions = findPrerequisiteConflicts(match, facts);
	const qualityStatus = (match.qualityStatus ?? "").toLowerCase();
	if (qualityStatus === "rejected") {
		contradictions.push("python_quality_rejected");
	}
	if (contradictions.length > 0) {
		return {
			state: "contradicted",
			satisfiedPreconditions: [],
			missingPreconditions: [...match.preconditions],
			contradictions,
		};
	}
	if (match.preconditions.length === 0) {
		return {
			state: "needs_verification",
			satisfiedPreconditions: [],
			// The card declares no conditions, so applicability cannot be
			// established and the card is shown as a direction to confirm rather
			// than as an applicable method. Naming a "missing" precondition the
			// record never had would send the agent after something that does not
			// exist in the corpus.
			missingPreconditions: [],
			contradictions: [],
		};
	}
	const factTokens = new Set(facts.flatMap((fact) => normalizedTokens(fact)));
	const satisfied: string[] = [];
	const missing: string[] = [];
	for (const precondition of match.preconditions) {
		const tokens = normalizedTokens(precondition);
		const backed = facts.length > 0 && tokens.some((token) => factTokens.has(token));
		if (backed) satisfied.push(precondition);
		else missing.push(precondition);
	}
	const state: ApplicabilityState =
		missing.length === 0 && satisfied.length > 0 ? "verified_applicable" : "needs_verification";
	// The Python layer is the authority on whether the *stored* preconditions
	// were confirmed when the card was curated. If it withheld adoption
	// (`ambiguous`), a lexical match on the current task must not upgrade the
	// card to "verified": that would re-derive a second standard.
	if (state === "verified_applicable" && qualityStatus === "ambiguous") {
		return {
			state: "needs_verification",
			satisfiedPreconditions: satisfied,
			missingPreconditions: missing.length > 0 ? missing : [...match.preconditions],
			contradictions: [],
		};
	}
	return { state, satisfiedPreconditions: satisfied, missingPreconditions: missing, contradictions: [] };
}

function hardGateReasons(match: KnowledgeCardHit, options: GateOptions): string[] {
	const reasons: string[] = [];
	if (options.category && match.category !== options.category) reasons.push("category_mismatch");
	if (options.injectedCardIds.includes(match.recordId)) reasons.push("already_injected");
	if (options.contradictedCardIds?.includes(match.recordId)) reasons.push("previously_contradicted");
	if (match.attackPatterns.length === 0 && !match.label.trim()) reasons.push("missing_attack_family");
	if (match.sourceUrls.length === 0) reasons.push("missing_provenance");
	const body = [match.challenge, ...match.preconditions, ...match.attackSteps, ...match.failureModes].join(" ");
	if (!body.trim()) reasons.push("empty_body");
	if ((body.match(/\ufffd/gu) ?? []).length >= 2) reasons.push("corrupted_text");
	return reasons;
}

/**
 * Apply a card to one gate. Decision order is: hard data gates -> three-state
 * applicability -> composite score floor. Verified cards may be injected with
 * their full method; needs_verification cards are injected only as a short
 * candidate direction (see {@link formatKnowledgeInjection}).
 */
export function gateCandidate(match: KnowledgeCardHit, options: GateOptions): GateOutcome {
	const hardReasons = hardGateReasons(match, options);
	const assessment = assessApplicability(match, options.evidence);
	const rankedScores = options.rankedScores ?? [match.score];
	const taxonomy = taxonomyMatchScore(match, options.evidence.techniques, options.objective ?? "");
	const overlap = evidenceOverlapScore(match, options.evidence.targetFacts);
	const fit = prerequisiteFitScore(assessment.satisfiedPreconditions.length, match.preconditions.length);
	const provenance = provenanceScore(match);
	const margin = marginScore(match.score, rankedScores);
	const quality = pythonQualityScore(match);
	const score =
		Math.round(
			(0.35 * taxonomy + 0.15 * overlap + 0.2 * fit + 0.1 * provenance + 0.15 * margin + 0.05 * quality) * 1000,
		) / 1000;
	const threshold = VERIFIED_ACCEPT_THRESHOLD;
	const breakdown: GateScoreBreakdown = {
		taxonomy: Math.round(taxonomy * 1000) / 1000,
		evidence: Math.round(overlap * 1000) / 1000,
		prerequisite: Math.round(fit * 1000) / 1000,
		provenance,
		margin: Math.round(margin * 1000) / 1000,
		pythonQuality: Math.round(quality * 1000) / 1000,
		final: score,
		threshold,
	};
	const base = {
		score,
		satisfiedPreconditions: assessment.satisfiedPreconditions,
		missingPreconditions: assessment.missingPreconditions,
		breakdown,
		match,
	};
	const reasons = [...hardReasons, ...assessment.contradictions];
	if (hardReasons.length > 0) {
		return { ...base, decision: "reject", applicability: assessment.state, reasons };
	}
	if (assessment.state === "contradicted") {
		return { ...base, decision: "reject", applicability: assessment.state, reasons };
	}
	if (score < GATE_SCORE_FLOOR) {
		return {
			...base,
			decision: "reject",
			applicability: assessment.state,
			reasons: [...reasons, "below_quality_floor"],
		};
	}
	const decision: KnowledgeGateDecision =
		assessment.state === "verified_applicable" && score >= threshold ? "accept" : "needs_verification";
	// The Python layer already decided *why* a card is uncertain; carry its
	// verdict through as an audit reason instead of silently re-deriving one.
	const pythonReasons: string[] = [];
	const qualityStatus = (match.qualityStatus ?? "").toLowerCase();
	if (qualityStatus === "ambiguous" && assessment.missingPreconditions.length > 0) {
		pythonReasons.push("python_unconfirmed_preconditions");
	}
	for (const reason of match.qualityReasons?.slice(0, 3) ?? []) pythonReasons.push(`python_${reason}`);
	return {
		...base,
		decision,
		applicability: assessment.state,
		reasons: [
			...reasons,
			decision === "accept" ? "applicability_verified" : "applicability_needs_verification",
			...pythonReasons,
		],
	};
}

export function gateCandidates(matches: readonly KnowledgeCardHit[], options: GateOptions): GateOutcome[] {
	const rankedScores = [...matches].map((match) => match.score).sort((left, right) => right - left);
	return matches.map((match) => gateCandidate(match, { ...options, rankedScores }));
}

// ============================================================================
// Injection formatting
// ============================================================================

function joinLimited(values: readonly string[], limit: number, separator = "; "): string {
	return values.slice(0, limit).join(separator);
}

export interface KnowledgeInjectionItem {
	match: KnowledgeCardHit;
	/** Composite retrieval quality; explicitly not a probability of solving. */
	score: number;
	applicability: ApplicabilityState;
	missingPreconditions?: readonly string[];
	/** Preconditions the current evidence already backs; empty for unverified cards. */
	satisfiedPreconditions?: readonly string[];
}

/**
 * Cost of *acting on* a knowledge suggestion, not the retrieval cost. Only
 * read-only verification is allowed before adoption, so unverified candidates
 * are always `low`; an adopted method may spend a bounded exploit attempt.
 */
export type KnowledgeActionCost = "low" | "medium";

/**
 * Knowledge suggestion reshaped as a verifiable task input (see the design's
 * structured input): the planner can schedule it, the executor knows which new
 * evidence would settle it, and the budget stays bounded. It is deliberately
 * not a prose instruction — `doneWhen` and `missing_preconditions` are the
 * acceptance check.
 */
export interface KnowledgeTaskInput {
	knowledge_id: string;
	technique: string;
	/** 1-based rank inside the injected set. */
	retrieval_rank: number;
	applicability: ApplicabilityState;
	supporting_evidence: string[];
	missing_preconditions: string[];
	suggested_action: { skill: string; goal: string };
	estimated_cost: KnowledgeActionCost;
	usage_policy: "execute_after_verification" | "verify_before_deeper_execution";
}

export interface KnowledgeInjectionOptions {
	/**
	 * Bootstrap mode: only short candidate directions are injected, because no
	 * evidence has been collected yet and a full PoC would anchor the agent on
	 * an unverified direction.
	 */
	compact?: boolean;
}

/**
 * Render the runtime knowledge block. Two shapes:
 *
 * - verified method (applicability=verified_applicable, non-compact): full
 *   preconditions, steps, PoC, failure modes.
 * - verification candidate: attack family, why it matched, missing conditions,
 *   and one cheap read-only check. No steps and no PoC, so uncertain knowledge
 *   cannot become an execution plan by itself.
 *
 * The score is published as `retrieval_quality_score` rather than `confidence`:
 * it ranks candidates, it is not a calibrated probability that the card applies.
 */
export function formatKnowledgeInjection(
	items: readonly KnowledgeInjectionItem[],
	trigger: RetrievalTrigger | string,
	revision: number,
	maxCards: number,
	maxCharacters: number,
	options: KnowledgeInjectionOptions = {},
): string {
	const blocks: string[] = [];
	for (let index = 0; index < items.length && index < maxCards; index += 1) {
		const item = items[index];
		const match = item.match;
		const detailed = !options.compact && item.applicability === "verified_applicable";
		const header = [
			`card_id: ${match.recordId}`,
			`category: ${match.category}`,
			`attack_family: ${match.attackPatterns[0] ?? match.label}`,
			`retrieval_quality_score: ${item.score}`,
			`applicability: ${item.applicability}`,
		].join(" | ");
		const lines = [header, `why_matched: ${joinLimited([match.whyMatched], 1)}`];
		if (detailed) {
			lines.push(
				`recognition_signals: ${joinLimited(match.recognitionSignals, 6)}`,
				`preconditions: ${joinLimited(match.preconditions, 4)}`,
				`attack_steps: ${joinLimited(match.attackSteps, 6)}`,
				`canonical_poc: ${match.canonicalPoc || match.poc}`,
				`failure_modes: ${joinLimited(match.failureModes, 4)}`,
				`source_urls: ${joinLimited(match.sourceUrls, 3, ", ")} | review_status: ${match.reviewStatus || "unreviewed"}`,
			);
		} else {
			// Fall back to the card's own conditions when the gate could not name
			// a specific missing one, so "none recorded" only appears when the
			// card truly declares nothing to verify.
			const missing =
				item.missingPreconditions && item.missingPreconditions.length > 0
					? item.missingPreconditions
					: match.preconditions;
			lines.push(
				`missing_preconditions: ${joinLimited(missing, 3) || "none recorded"}`,
				`cheap_verification: ${match.recognitionSignals[0] ?? match.preconditions[0] ?? "confirm the attack family applies to the current target"}`,
				"usage_policy: verify_before_deeper_execution",
				`source_urls: ${joinLimited(match.sourceUrls, 2, ", ")}`,
			);
		}
		blocks.push(lines.join("\n"));
	}
	const mode = options.compact ? "verification_candidates" : "mixed";
	const open = `<runtime_attack_knowledge trigger="${trigger}" revision="${revision}" mode="${mode}">`;
	const close = "</runtime_attack_knowledge>";
	let body = blocks.join("\n\n");
	const budget = Math.max(0, maxCharacters - open.length - close.length - 2);
	if (body.length > budget) body = `${body.slice(0, Math.max(0, budget - 3))}...`;
	return `${open}\n${body}\n${close}`;
}

// ============================================================================
// Knowledge -> verifiable task input
// ============================================================================

function techniqueLabel(match: KnowledgeCardHit): string {
	return match.attackPatterns[0] ?? match.label ?? match.recordId;
}

/** Observed facts that back this candidate; never the card's own text. */
function supportingEvidence(
	match: KnowledgeCardHit,
	evidence: SolveKnowledgeEvidence,
	satisfied: readonly string[],
): string[] {
	if (evidence.targetFacts.length === 0) return [];
	const wanted = new Set(
		(satisfied.length > 0 ? satisfied : [techniqueLabel(match)]).flatMap((value) => normalizedTokens(value)),
	);
	return evidence.targetFacts.filter((fact) => normalizedTokens(fact).some((token) => wanted.has(token))).slice(0, 5);
}

/**
 * Reshape injected candidates into scheduled task inputs. This is the bridge
 * between "the knowledge base suggested something" and "the planner may spend
 * budget on it": every input names the observation that settles it, so an
 * unverified direction can only buy a cheap read-only check.
 */
export function buildKnowledgeTaskInputs(
	items: readonly KnowledgeInjectionItem[],
	evidence: SolveKnowledgeEvidence,
	limit = DEFAULT_MAX_INJECTED_CARDS,
): KnowledgeTaskInput[] {
	return items.slice(0, limit).map((item, index) => {
		const technique = techniqueLabel(item.match);
		const missing = [...(item.missingPreconditions ?? [])].slice(0, 3);
		const verified = item.applicability === "verified_applicable";
		return {
			knowledge_id: item.match.recordId,
			technique,
			retrieval_rank: index + 1,
			applicability: item.applicability,
			supporting_evidence: supportingEvidence(item.match, evidence, item.satisfiedPreconditions ?? []),
			missing_preconditions: missing,
			suggested_action: verified
				? { skill: "apply_technique", goal: `apply ${technique} against the current target` }
				: {
						skill: "verify_precondition",
						goal: `confirm: ${missing[0] ?? "the attack family applies to the current target"}`,
					},
			estimated_cost: verified ? "medium" : "low",
			usage_policy: verified ? "execute_after_verification" : "verify_before_deeper_execution",
		};
	});
}

// ============================================================================
// Persistence and audit
// ============================================================================

interface PersistedSolveKnowledgeState {
	task?: { keyHash: string; source: SolveTaskSource; solveMode: boolean; category?: AttackCategory };
	evidence: SolveKnowledgeEvidence;
	retrieval: {
		bootstrapDone: boolean;
		pendingTrigger?: RetrievalTrigger;
		count: number;
		seenQueryFingerprints: string[];
		queryStates?: Record<string, QueryOutcomeState>;
		contradictedCardIds?: string[];
		injectedCardIds: string[];
		recoveryEpoch: number;
		refinedForRevision?: number;
	};
}

function emptyEvidence(): SolveKnowledgeEvidence {
	return { revision: 0, phase: "", techniques: [], targetFacts: [], failedRoutes: [] };
}

function emptyLedger(): RetrievalLedger {
	return {
		bootstrapDone: false,
		count: 0,
		seenQueryFingerprints: [],
		injectedCardIds: [],
		recoveryEpoch: 0,
		queryStates: {},
		contradictedCardIds: [],
	};
}

function emptyState(): SolveKnowledgeState {
	return { evidence: emptyEvidence(), retrieval: emptyLedger() };
}

// ============================================================================
// Coordinator (KnowledgeRetrievalCoordinator)
// ============================================================================

interface InjectionRecord {
	cardId: string;
	missing: string[];
	failureModes: string[];
	turn: number;
	usedAtRevision?: number;
	outcomeReported?: boolean;
	failureRoutes: string[];
}

export class KnowledgeRetrievalCoordinator {
	private readonly options: KnowledgeRetrievalCoordinatorOptions;
	private readonly maxInjectedCards: number;
	private readonly maxInjectedCharacters: number;
	private readonly hardTimeoutMs: number;
	/** Budget for the first retrieval of a task, which pays the cold index load. */
	private readonly firstRetrievalMs: number;
	private state: SolveKnowledgeState = emptyState();
	private taskKeyHash = "";
	private sessionId = "";
	private stuckStreak = 0;
	private lastStallRetrievalStreak = 0;
	/** Session-level exclusion; the root session writes it, shared children only read it. */
	private sessionAllowed = true;
	/** Lease objectives already handled by runLeaseRetrieval (one retrieval per distinct objective). */
	private readonly leaseFingerprints: string[] = [];
	/** Card IDs injected by lease retrievals; excluded from later lease selections. */
	private readonly leaseInjectedCardIds: string[] = [];
	/** Content hashes of recently observed tool results (cross-hook de-duplication). */
	private readonly recentObservationHashes: string[] = [];
	/** Injected cards and the conditions/outcomes the decision trace follows. */
	private readonly injectionRecords = new Map<string, InjectionRecord>();

	constructor(options: KnowledgeRetrievalCoordinatorOptions) {
		this.options = options;
		this.maxInjectedCards = Math.max(1, options.maxInjectedCards ?? DEFAULT_MAX_INJECTED_CARDS);
		// Honour the caller's budget: the previous 1_000-character floor silently
		// ignored tighter limits requested by constrained sessions. 240 still fits
		// one compact verification candidate.
		this.maxInjectedCharacters = Math.max(
			MIN_INJECTED_CHARACTERS,
			options.maxInjectedCharacters ?? DEFAULT_MAX_INJECTED_CHARACTERS,
		);
		this.hardTimeoutMs = Math.max(1, options.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS);
		// An explicit value wins in both directions: a caller that knows it has no
		// cold-start cost must be able to keep the first retrieval short too.
		this.firstRetrievalMs = Math.max(
			1,
			options.firstRetrievalTimeoutMs ?? Math.max(this.hardTimeoutMs, FIRST_RETRIEVAL_TIMEOUT_MS),
		);
		// An explicit value wins in both directions: a caller that knows it has no
		// cold-start cost must be able to keep the first retrieval short too.
		this.firstRetrievalMs = Math.max(
			1,
			options.firstRetrievalTimeoutMs ?? Math.max(this.hardTimeoutMs, FIRST_RETRIEVAL_TIMEOUT_MS),
		);
	}

	shadowEnabled(): boolean {
		return this.options.shadow === true;
	}

	setSessionAllowed(allowed: boolean): void {
		this.sessionAllowed = allowed;
	}

	isSolveMode(): boolean {
		return this.state.task?.solveMode === true;
	}

	getState(): SolveKnowledgeState {
		return this.state;
	}

	attachSession(sessionId: string): void {
		// The coordinator instance is shared with in-process children; the
		// first attach wins and subsequent attaches with the same ID are no-ops.
		if (!sessionId || this.sessionId) return;
		this.sessionId = sessionId;
		this.loadState();
	}

	/**
	 * Bind the current prompt context. Generic continuations ("keep going",
	 * "try another angle") inherit the existing task; only a new task ID, a new
	 * target endpoint, or an explicit reset switches tasks.
	 */
	resolveAndBind(input: SolveContextInput): boolean {
		const resolved = resolveSolveTask(input);
		if (!resolved) return false;
		const resolvedHash = stableTaskKeyHash(resolved.key);
		const sameTask = this.taskKeyHash === resolvedHash && this.state.task?.source === resolved.source;
		if (sameTask) {
			// Refresh the in-memory task fields (persisted state stores only
			// hashes) without touching the accumulated evidence or the ledger.
			this.state.task = resolved;
			if (!this.state.retrieval.bootstrapDone) {
				this.state.retrieval.pendingTrigger = "task_bootstrap";
			}
			return false;
		}
		this.state = emptyState();
		this.state.task = resolved;
		this.taskKeyHash = resolvedHash;
		this.state.retrieval.pendingTrigger = "task_bootstrap";
		this.stuckStreak = 0;
		this.lastStallRetrievalStreak = 0;
		this.persistState();
		return true;
	}

	/** Refresh the competition task context once the immutable envelope is claimed. */
	bindCompetitionEnvelope(input: CompetitionSolveContext): void {
		const category = normalizeAttackCategory(input.category);
		if (!category) return;
		const task: SolveKnowledgeTask = {
			key: input.taskId.trim() || stableTaskKeyHash([input.name, input.description].filter(Boolean).join(" ")),
			source: "competition",
			solveMode: true,
			category,
			objective: [input.name, input.description]
				.filter((value) => value?.trim())
				.join(" - ")
				.slice(0, MAX_OBJECTIVE_CHARS),
		};
		const taskHash = stableTaskKeyHash(task.key);
		const sameTask = this.taskKeyHash === taskHash && this.state.task?.source === "competition";
		if (sameTask && this.state.task) {
			this.state.task = { ...this.state.task, ...task };
			return;
		}
		this.state = emptyState();
		this.state.task = task;
		this.taskKeyHash = taskHash;
		this.state.retrieval.pendingTrigger = "task_bootstrap";
		this.stuckStreak = 0;
		this.lastStallRetrievalStreak = 0;
		this.persistState();
	}

	/** Bootstrap runs once per task before the first model call; content enters the system prompt. */
	/**
	 * Bootstrap for a session whose task was never bound.
	 *
	 * Whether this is a CTF task is a property of the session (a verified
	 * challenge descriptor or a competition envelope), not of the wording: an
	 * automated brief says "solve this challenge, attachments in ..." and names
	 * no attack verb, so any keyword test rejects it and the corpus is never
	 * consulted. Using the descriptor keeps the trigger from moving when the
	 * harness phrasing does.
	 *
	 * Retrieval stays bounded and the gate is unchanged: one pass per task, and
	 * nothing is injected unless a card actually matches.
	 */
	async runBootstrapAttempt(descriptor?: TaskDescriptorContext): Promise<string | undefined> {
		if (this.state.task) return this.runBootstrap();
		if (this.state.retrieval.bootstrapDone) return undefined;
		if (!this.options.knowledgeBaseEnabled()) return undefined;
		const inferred = descriptor?.isCtf === true ? taskFromDescriptor(descriptor) : undefined;
		if (!inferred) return undefined;
		this.state = emptyState();
		this.state.task = inferred;
		this.taskKeyHash = stableTaskKeyHash(inferred.key);
		this.state.retrieval.pendingTrigger = "task_bootstrap";
		return this.runRetrieval("task_bootstrap");
	}

	/** Bootstrap runs once per task before the first model call; content enters the system prompt. */
	async runBootstrap(): Promise<string | undefined> {
		if (this.state.retrieval.pendingTrigger !== "task_bootstrap") return undefined;
		const snippet = await this.runRetrieval("task_bootstrap");
		if (this.state.retrieval.bootstrapDone) this.state.retrieval.pendingTrigger = undefined;
		return snippet;
	}

	/**
	 * Fine-grained retrieval for a planning-executor lease (execution-focused
	 * knowledge; CRAKEN's ablation shows execution-time retrieval of fine-grained
	 * techniques outperforms planning-time retrieval). Independent of the outer
	 * task ledger: exactly one retrieval per distinct lease objective, and the
	 * parent's accumulated state is read for gate scoring but never mutated.
	 * The snippet is injected into the executor session's system prompt by the
	 * extension layer; the planning runtime stays untouched.
	 */
	async runLeaseRetrieval(signals: PlanningLeaseSignals): Promise<string | undefined> {
		const objective = signals.objective.replace(/\s+/gu, " ").trim();
		if (!objective) return undefined;
		const leaseFingerprint = stableTaskKeyHash(`lease|${objective}`);
		if (this.leaseFingerprints.includes(leaseFingerprint)) return undefined;
		this.leaseFingerprints.push(leaseFingerprint);
		const started = Date.now();
		const allowed = this.options.knowledgeBaseEnabled() && this.sessionAllowed;
		if (!allowed) {
			this.appendAudit({
				timestamp: new Date().toISOString(),
				session_id: this.sessionId,
				task_key_hash: this.taskKeyHash,
				turn: this.options.getTurn(),
				phase: "exploit",
				evidence_revision: this.state.evidence.revision,
				trigger: "lease_bootstrap",
				allowed: false,
				category: this.state.task?.category ?? "",
				query_fingerprint: "",
				candidate_count: 0,
				accepted_ids: [],
				rejected_reasons: [],
				decision: "skipped_not_allowed",
				latency_ms: 0,
			});
			return undefined;
		}
		const leaseEvidence = extractToolEvidence(
			"planning_lease",
			sanitizeToolText(objective),
			this.state.task?.category,
		);
		const spec: KnowledgeQuerySpec = {
			category: this.state.task?.category ?? inferCategoryFromLeaseObjective(objective),
			phase: leaseEvidence.phase ?? "exploit",
			objective: objective.slice(0, MAX_OBJECTIVE_CHARS),
			techniques: aliasNormalizeAll(leaseEvidence.techniques.slice(0, 8)),
			facts: aliasNormalizeAll(leaseEvidence.facts.slice(0, 8)),
			failedRoutes: [],
			need: [...LEASE_NEEDS],
		};
		const { candidates, error } = await this.retrieve(spec, this.leaseInjectedCardIds);
		// Merge the lease's freshly extracted techniques with the parent's
		// accumulated target facts: facts sharpen gate scoring and catch
		// mitigation conflicts; the parent state itself stays read-only here.
		const gateEvidence: SolveKnowledgeEvidence = {
			revision: this.state.evidence.revision,
			phase: spec.phase,
			techniques: aliasNormalizeAll([...leaseEvidence.techniques, ...this.state.evidence.techniques.slice(-4)]),
			targetFacts: this.state.evidence.targetFacts,
			failedRoutes: this.state.evidence.failedRoutes,
		};
		const gated = gateCandidates(candidates, {
			category: spec.category,
			evidence: gateEvidence,
			injectedCardIds: [...this.state.retrieval.injectedCardIds, ...this.leaseInjectedCardIds],
			rankedScores: candidates.map((match) => match.score),
			objective: spec.objective,
			trigger: "task_bootstrap",
			contradictedCardIds: this.state.retrieval.contradictedCardIds,
		});
		// Executor leases are evidence-seeking by construction, so a verified
		// method is injected in full; needs_verification cards stay short.
		const selected: KnowledgeInjectionItem[] = [];
		let totalCharacters = 0;
		const ranked = [...gated]
			.filter((outcome) => outcome.decision !== "reject")
			.sort((left, right) => {
				const leftRank = left.decision === "accept" ? 0 : 1;
				const rightRank = right.decision === "accept" ? 0 : 1;
				return leftRank - rightRank || right.score - left.score;
			});
		for (const outcome of ranked) {
			if (selected.length >= this.maxInjectedCards) break;
			const item: KnowledgeInjectionItem = {
				match: outcome.match,
				score: outcome.score,
				applicability: outcome.applicability,
				missingPreconditions: outcome.missingPreconditions,
				satisfiedPreconditions: outcome.satisfiedPreconditions,
			};
			const block = formatKnowledgeInjection([item], "lease_bootstrap", 0, 1, Number.MAX_SAFE_INTEGER);
			if (totalCharacters + block.length > this.maxInjectedCharacters && selected.length > 0) break;
			selected.push(item);
			totalCharacters += block.length;
		}
		const selectedMatches = selected.map((item) => item.match);
		pushUnique(
			this.leaseInjectedCardIds,
			selectedMatches.map((match) => match.recordId),
		);
		this.rememberInjections(selected);
		this.appendAudit({
			timestamp: new Date().toISOString(),
			session_id: this.sessionId,
			task_key_hash: this.taskKeyHash,
			turn: this.options.getTurn(),
			phase: spec.phase,
			evidence_revision: this.state.evidence.revision,
			trigger: "lease_bootstrap",
			allowed: true,
			category: spec.category ?? "",
			query_fingerprint: queryFingerprint(spec),
			candidate_count: candidates.length,
			accepted_ids: selectedMatches.map((match) => match.recordId),
			rejected_reasons: gated.flatMap((outcome) =>
				outcome.decision === "reject"
					? outcome.reasons.slice(0, 3).map((reason) => ({ id: outcome.match.recordId, reason }))
					: [],
			),
			decision:
				selected.length > 0
					? selected.some((item) => item.applicability === "verified_applicable")
						? "injected"
						: "injected_candidates"
					: candidates.length > 0
						? "rejected_all"
						: "empty_result",
			latency_ms: Date.now() - started,
			...(error ? { error } : {}),
			event: "knowledge_evaluated",
			gate_scores: gated.map((outcome) => this.gateAuditScore(outcome, "task_bootstrap")),
		});
		if (selected.length === 0) return undefined;
		return formatKnowledgeInjection(
			selected,
			"lease_bootstrap",
			this.state.evidence.revision,
			this.maxInjectedCards,
			this.maxInjectedCharacters,
		);
	}

	/**
	 * Record evidence from a tool result. Never issues a retrieval directly:
	 * the next context hook merges the whole turn's results into one search so
	 * parallel tool batches stay compatible and the model sees the result
	 * before its next inference.
	 *
	 * Legacy-hosted tools (code_run, file_read, web_scan, verb calls) reach this
	 * method too: they are the highest-value evidence source for pwn/web tasks
	 * and used to be skipped by an early return in the tool_result hook.
	 */
	observeToolResult(toolName: string, text: string, isError: boolean): void {
		const task = this.state.task;
		if (!task) return;
		const sanitized = sanitizeToolText(text);
		// The same result can reach several hooks (native tool_result, legacy
		// supervisor). De-duplicate on content so one result counts once.
		if (!this.isFreshObservation(toolName, sanitized)) return;
		const extracted = extractToolEvidence(toolName, sanitized, task.category);
		const facts = extracted.facts.filter((fact) => !this.state.evidence.targetFacts.includes(fact));
		const techniques = extracted.techniques.filter(
			(technique) => !this.state.evidence.techniques.includes(technique),
		);
		const phaseChange = extracted.phase !== undefined && extracted.phase !== this.state.evidence.phase;
		let failedRoute: string | undefined;
		if (isError && extracted.failedRoute && !this.state.evidence.failedRoutes.includes(extracted.failedRoute)) {
			failedRoute = extracted.failedRoute;
		}
		if (facts.length === 0 && techniques.length === 0 && !phaseChange && !failedRoute) return;
		pushUnique(this.state.evidence.targetFacts, facts);
		this.state.evidence.targetFacts = this.state.evidence.targetFacts.slice(-MAX_EVIDENCE_FACTS);
		pushUnique(this.state.evidence.techniques, techniques);
		this.state.evidence.techniques = this.state.evidence.techniques.slice(-MAX_EVIDENCE_TECHNIQUES);
		if (failedRoute) {
			this.state.evidence.failedRoutes.push(failedRoute);
			this.state.evidence.failedRoutes = this.state.evidence.failedRoutes.slice(-MAX_FAILED_ROUTES);
			this.state.evidence.failureSignature = createHash("sha256")
				.update(this.state.evidence.failedRoutes.join("\n"), "utf8")
				.digest("hex")
				.slice(0, 16);
		}
		if (phaseChange) this.state.evidence.phase = extracted.phase ?? this.state.evidence.phase;
		this.state.evidence.revision += 1;
		// A pending mandatory bootstrap must survive claim-triggered evidence:
		// bindCompetitionEnvelope sets task_bootstrap right before this tool
		// result is observed, and overriding it would lose the bootstrap query
		// semantics (lower threshold, different need list) for the session.
		if (this.state.retrieval.pendingTrigger !== "task_bootstrap") {
			this.state.retrieval.pendingTrigger = "evidence_refinement";
		}
		this.traceKnowledgeUsage(facts, failedRoute);
		this.persistState();
	}

	/** Content-level de-duplication across hooks (bounded ring). */
	private isFreshObservation(toolName: string, sanitized: string): boolean {
		if (!sanitized.trim()) return false;
		const digest = createHash("sha256").update(`${toolName}\x1f${sanitized}`, "utf8").digest("hex");
		if (this.recentObservationHashes.includes(digest)) return false;
		this.recentObservationHashes.push(digest);
		if (this.recentObservationHashes.length > 32) this.recentObservationHashes.shift();
		return true;
	}

	/**
	 * Knowledge Decision Trace — `knowledge_used` / `knowledge_outcome`.
	 *
	 * Deliberately derived from deterministic evidence, never from model
	 * reasoning: a pending card is "used" when new tool evidence satisfies one of
	 * the preconditions it was waiting on, and "outcome=failed" when the failure
	 * route matches one of its recorded failure modes.
	 */
	private traceKnowledgeUsage(facts: readonly string[], failedRoute?: string): void {
		if (this.injectionRecords.size === 0) return;
		const factTokens = new Set(this.state.evidence.targetFacts.flatMap((fact) => normalizedTokens(fact)));
		for (const record of [...this.injectionRecords.values()]) {
			const stillMissing: string[] = [];
			const satisfiedNow: string[] = [];
			for (const condition of record.missing) {
				const tokens = normalizedTokens(condition);
				if (tokens.length > 0 && tokens.some((token) => factTokens.has(token))) satisfiedNow.push(condition);
				else stillMissing.push(condition);
			}
			if (satisfiedNow.length > 0) {
				this.appendAudit({
					timestamp: new Date().toISOString(),
					session_id: this.sessionId,
					task_key_hash: this.taskKeyHash,
					turn: this.options.getTurn(),
					phase: this.state.evidence.phase,
					evidence_revision: this.state.evidence.revision,
					trigger: "knowledge_usage",
					allowed: true,
					category: this.state.task?.category ?? "",
					query_fingerprint: "",
					candidate_count: 0,
					accepted_ids: [],
					rejected_reasons: [],
					decision: "used",
					latency_ms: 0,
					event: "knowledge_used",
					knowledge_id: record.cardId,
					detail: {
						satisfied_preconditions: satisfiedNow,
						missing_preconditions: stillMissing,
						turns_since_injection: this.options.getTurn() - record.turn,
					},
				});
				record.missing = stillMissing;
				record.usedAtRevision = this.state.evidence.revision;
			}
			if (failedRoute && stillMissing.length === 0 && record.outcomeReported !== true) {
				const routeTokens = new Set(normalizedTokens(failedRoute));
				const hit = record.failureModes.some((mode) =>
					normalizedTokens(mode).some((token) => routeTokens.has(token)),
				);
				if (hit) {
					this.appendAudit({
						timestamp: new Date().toISOString(),
						session_id: this.sessionId,
						task_key_hash: this.taskKeyHash,
						turn: this.options.getTurn(),
						phase: this.state.evidence.phase,
						evidence_revision: this.state.evidence.revision,
						trigger: "knowledge_outcome",
						allowed: true,
						category: this.state.task?.category ?? "",
						query_fingerprint: "",
						candidate_count: 0,
						accepted_ids: [],
						rejected_reasons: [],
						decision: "outcome_failed",
						latency_ms: 0,
						event: "knowledge_outcome",
						knowledge_id: record.cardId,
						detail: {
							outcome: "failed",
							failed_route: failedRoute,
							tool_turns_spent: this.options.getTurn() - record.turn,
							evidence_gained: record.usedAtRevision !== undefined,
						},
					});
					record.outcomeReported = true;
					record.failureRoutes.push(failedRoute);
				}
			}
		}
	}

	/**
	 * Context-hook flush. Merges the pending evidence trigger with stall
	 * recovery epochs from the progress judge. Retrieval never updates the
	 * evidence revision and never resets the judge's stall counters.
	 */
	async flushContext(judgeStatus?: string): Promise<string | undefined> {
		if (!this.state.task) return undefined;
		let trigger: RetrievalTrigger | undefined;
		if (judgeStatus === "stuck") {
			// First entry into a stall epoch triggers, then every second
			// consecutive stuck verdict re-triggers; the judge's stall counters
			// are never reset by retrieval.
			this.stuckStreak += 1;
			if (this.stuckStreak === 1 || this.stuckStreak - this.lastStallRetrievalStreak >= 2) {
				this.state.retrieval.recoveryEpoch = Math.max(this.state.retrieval.recoveryEpoch, this.stuckStreak);
				this.lastStallRetrievalStreak = this.stuckStreak;
				trigger = "stall_recovery";
			}
		} else if (judgeStatus && judgeStatus !== "on_track") {
			this.stuckStreak = 0;
			this.lastStallRetrievalStreak = 0;
		}
		if (!trigger) trigger = this.state.retrieval.pendingTrigger;
		if (!trigger) return undefined;
		const snippet = await this.runRetrieval(trigger);
		if (trigger === this.state.retrieval.pendingTrigger) this.state.retrieval.pendingTrigger = undefined;
		return snippet;
	}

	/** Log the legacy prompt-regex decision for shadow comparison without injecting. */
	recordShadowComparison(prompt: string, legacyWouldPrefetch: boolean, legacyQuery = ""): void {
		this.appendAudit({
			timestamp: new Date().toISOString(),
			session_id: this.sessionId,
			task_key_hash: this.taskKeyHash || stableTaskKeyHash(prompt),
			turn: this.options.getTurn(),
			phase: this.state.evidence.phase,
			evidence_revision: this.state.evidence.revision,
			trigger: "shadow_legacy_regex",
			allowed: true,
			category: this.state.task?.category ?? "",
			query_fingerprint: legacyQuery ? stableTaskKeyHash(legacyQuery) : "",
			candidate_count: 0,
			accepted_ids: [],
			rejected_reasons: [],
			decision: legacyWouldPrefetch ? "legacy_regex_match" : "legacy_regex_skip",
			latency_ms: 0,
		});
	}

	private async runRetrieval(trigger: RetrievalTrigger): Promise<string | undefined> {
		const state = this.state;
		const task = state.task;
		if (!task) return undefined;
		const started = Date.now();
		const allowed = this.options.knowledgeBaseEnabled() && this.sessionAllowed;
		if (!allowed) {
			this.logDecision(trigger, {
				allowed: false,
				decision: "skipped_not_allowed",
				candidateCount: 0,
				latencyMs: 0,
			});
			return undefined;
		}
		let spec = buildKnowledgeQuerySpec(task, state.evidence, trigger);
		const fingerprint = queryFingerprint(spec);
		const cacheDecision = this.queryCacheDecision(fingerprint);
		if (cacheDecision !== "run") {
			// A definitive earlier result is permanent dedupe; an exhausted
			// timeout/error keeps the bootstrap pending instead of marking the
			// task as "already bootstrapped" on a transient failure.
			if (trigger === "task_bootstrap" && cacheDecision === "duplicate") {
				state.retrieval.bootstrapDone = true;
			}
			this.logDecision(trigger, {
				allowed: true,
				decision: cacheDecision === "duplicate" ? "duplicate_fingerprint_skipped" : "retry_exhausted",
				queryFingerprint: fingerprint,
				candidateCount: 0,
				latencyMs: 0,
			});
			this.persistState();
			return undefined;
		}
		let retrieved = await this.retrieve(spec);
		let candidates = retrieved.candidates;
		let gated = this.gateAll(candidates, spec, trigger);
		let evaluable = gated.filter((outcome) => outcome.decision !== "reject");
		// One deterministic RQ-RAG-style rewrite when nothing is adoptable; no
		// extra LLM calls are introduced on the mandatory path.
		if (
			evaluable.length === 0 &&
			trigger === "evidence_refinement" &&
			state.retrieval.refinedForRevision !== state.evidence.revision
		) {
			const refineCandidate = gated.find((outcome) => outcome.decision === "needs_verification");
			if (refineCandidate) {
				const refinedSpec: KnowledgeQuerySpec = {
					...spec,
					need: [...spec.need, "alternative attack families"],
					failedRoutes: [
						...spec.failedRoutes,
						...aliasNormalizeAll(refineCandidate.match.failureModes.slice(0, 2)),
					],
				};
				const refinedFingerprint = queryFingerprint(refinedSpec);
				if (this.queryCacheDecision(refinedFingerprint) === "run") {
					state.retrieval.refinedForRevision = state.evidence.revision;
					retrieved = await this.retrieve(refinedSpec);
					candidates = retrieved.candidates;
					gated = this.gateAll(candidates, refinedSpec, trigger);
					evaluable = gated.filter((outcome) => outcome.decision !== "reject");
					spec = refinedSpec;
				}
			}
		}
		state.retrieval.count += 1;
		this.recordQueryOutcome(fingerprint, retrieved, candidates.length);
		if (trigger === "task_bootstrap" && retrieved.status === "ok") {
			// Bootstrapped means "a definitive retrieval happened", not "a call
			// was attempted": timeout/error keep it pending for a bounded retry.
			state.retrieval.bootstrapDone = true;
		}
		// Contradicted cards are not re-offered for this task.
		for (const outcome of gated) {
			if (outcome.applicability === "contradicted") {
				pushUnique(state.retrieval.contradictedCardIds, [outcome.match.recordId]);
			}
		}
		const compact = trigger === "task_bootstrap";
		// One card per technique: three restatements of the same method spend
		// three slots and three times the budget to teach one idea.
		const ranked = evaluable
			.filter((outcome) => outcome.decision === "accept" || outcome.score >= UNVERIFIED_INJECTION_FLOOR)
			.sort((left, right) => {
				const leftRank = left.decision === "accept" ? 0 : 1;
				const rightRank = right.decision === "accept" ? 0 : 1;
				return leftRank - rightRank || right.score - left.score;
			});
		const items: KnowledgeInjectionItem[] = [];
		let totalCharacters = 0;
		for (const outcome of ranked) {
			if (items.length >= this.maxInjectedCards) break;
			if (items.some((chosen) => isSameInjectionFamily(chosen.match, outcome.match))) continue;
			const item: KnowledgeInjectionItem = {
				match: outcome.match,
				score: outcome.score,
				applicability: outcome.applicability,
				missingPreconditions: outcome.missingPreconditions,
				satisfiedPreconditions: outcome.satisfiedPreconditions,
			};
			const block = formatKnowledgeInjection([item], trigger, state.evidence.revision, 1, Number.MAX_SAFE_INTEGER, {
				compact,
			});
			if (totalCharacters + block.length > this.maxInjectedCharacters && items.length > 0) break;
			items.push(item);
			totalCharacters += block.length;
		}
		const selectedIds = items.map((item) => item.match.recordId);
		pushUnique(state.retrieval.injectedCardIds, selectedIds);
		this.rememberInjections(items);
		this.persistState();
		const rejectedReasons = gated.flatMap((outcome) =>
			outcome.decision === "reject"
				? outcome.reasons.slice(0, 3).map((reason) => ({ id: outcome.match.recordId, reason }))
				: [],
		);
		this.logRetrievalTrace(trigger, fingerprint, candidates, gated, retrieved);
		// Render first: the audit must report the size of the text the model
		// really received, not the sum of per-card previews.
		const injection =
			items.length === 0
				? undefined
				: formatKnowledgeInjection(
						items,
						trigger,
						state.evidence.revision,
						this.maxInjectedCards,
						this.maxInjectedCharacters,
						{ compact },
					);
		this.logDecision(trigger, {
			allowed: true,
			decision:
				items.length > 0
					? items.some((item) => item.applicability === "verified_applicable")
						? "injected"
						: "injected_candidates"
					: candidates.length > 0
						? "rejected_all"
						: "empty_result",
			queryFingerprint: fingerprint,
			candidateCount: candidates.length,
			acceptedIds: selectedIds,
			rejectedReasons,
			latencyMs: Date.now() - started,
			error: retrieved.error,
			gateScores: gated.map((outcome) => this.gateAuditScore(outcome, trigger)),
			retrievalLatencyMs: retrieved.latencyMs,
			...(retrieved.snapshot ? { knowledgeBaseSnapshot: retrieved.snapshot } : {}),
			injectedCardIds: selectedIds,
			injectedCharacters: injection?.length ?? 0,
			injectedIntoContext: injection !== undefined,
		});
		return injection;
	}

	/**
	 * Cache decision for one query fingerprint. Only a success (candidates
	 * returned) is permanent dedupe. Empty results expire with new evidence or
	 * after a short TTL; timeout/error allow a bounded number of retries.
	 */
	private queryCacheDecision(fingerprint: string): "run" | "duplicate" | "exhausted" {
		const cached = this.state.retrieval.queryStates[fingerprint];
		if (!cached) return "run";
		if (cached.status === "success") return "duplicate";
		if (cached.status === "empty") {
			const sameRevision = cached.revision === this.state.evidence.revision;
			const withinTtl = this.options.getTurn() - cached.turn <= EMPTY_QUERY_TTL_TURNS;
			return sameRevision && withinTtl ? "duplicate" : "run";
		}
		return cached.attempts >= MAX_QUERY_ATTEMPTS ? "exhausted" : "run";
	}

	private recordQueryOutcome(
		fingerprint: string,
		retrieved: { status: "ok" | "timeout" | "error"; snapshot?: KnowledgeBaseSnapshot; error?: string },
		candidateCount: number,
	): void {
		const status: QueryOutcomeStatus =
			retrieved.status === "ok" ? (candidateCount > 0 ? "success" : "empty") : retrieved.status;
		const previous = this.state.retrieval.queryStates[fingerprint];
		this.state.retrieval.queryStates[fingerprint] = {
			status,
			attempts: (previous?.attempts ?? 0) + 1,
			revision: this.state.evidence.revision,
			turn: this.options.getTurn(),
		};
		if (status === "success" || status === "empty") {
			pushUnique(this.state.retrieval.seenQueryFingerprints, [fingerprint]);
		}
	}

	private rememberInjections(items: readonly KnowledgeInjectionItem[]): void {
		for (const item of items) {
			const existing = this.injectionRecords.get(item.match.recordId);
			const missing = [...(item.missingPreconditions ?? [])];
			if (existing) {
				existing.missing = missing;
				continue;
			}
			this.injectionRecords.set(item.match.recordId, {
				cardId: item.match.recordId,
				missing,
				failureModes: [...item.match.failureModes],
				turn: this.options.getTurn(),
				failureRoutes: [],
			});
		}
	}

	private gateAuditScore(outcome: GateOutcome, trigger: RetrievalTrigger): GateAuditScore {
		return {
			card_id: outcome.match.recordId,
			trigger,
			taxonomy_score: outcome.breakdown.taxonomy,
			evidence_score: outcome.breakdown.evidence,
			prerequisite_score: outcome.breakdown.prerequisite,
			provenance_score: outcome.breakdown.provenance,
			margin_score: outcome.breakdown.margin,
			python_quality_score: outcome.breakdown.pythonQuality,
			final_score: outcome.breakdown.final,
			gate_threshold: outcome.breakdown.threshold,
			gate_decision: outcome.decision,
			applicability: outcome.applicability,
			missing_conditions: outcome.missingPreconditions.slice(0, 5),
			quality_status: outcome.match.qualityStatus || "unknown",
		};
	}

	private logRetrievalTrace(
		trigger: RetrievalTrigger,
		fingerprint: string,
		candidates: readonly KnowledgeCardHit[],
		gated: readonly GateOutcome[],
		retrieved: { latencyMs: number; snapshot?: KnowledgeBaseSnapshot },
	): void {
		this.appendAudit({
			timestamp: new Date().toISOString(),
			session_id: this.sessionId,
			task_key_hash: this.taskKeyHash,
			turn: this.options.getTurn(),
			phase: this.state.evidence.phase,
			evidence_revision: this.state.evidence.revision,
			trigger,
			allowed: true,
			category: this.state.task?.category ?? "",
			query_fingerprint: fingerprint,
			candidate_count: candidates.length,
			accepted_ids: gated
				.filter((outcome) => outcome.decision === "accept")
				.map((outcome) => outcome.match.recordId),
			rejected_reasons: [],
			decision: "retrieved",
			latency_ms: retrieved.latencyMs,
			event: "knowledge_retrieved",
			knowledge_base_enabled: this.options.knowledgeBaseEnabled(),
			...(retrieved.snapshot ? { knowledge_base_snapshot: retrieved.snapshot } : {}),
			retrieval_latency_ms: retrieved.latencyMs,
			detail: {
				candidates: candidates.slice(0, 8).map((match) => ({
					card_id: match.recordId,
					score: match.score,
					quality_status: match.qualityStatus || "unknown",
					source_urls: match.sourceUrls.slice(0, 2),
				})),
			},
		});
	}

	private gateAll(
		candidates: readonly KnowledgeCardHit[],
		spec: KnowledgeQuerySpec,
		trigger: RetrievalTrigger,
	): GateOutcome[] {
		return gateCandidates(candidates, {
			category: spec.category,
			evidence: this.state.evidence,
			injectedCardIds: this.state.retrieval.injectedCardIds,
			rankedScores: candidates.map((match) => match.score),
			objective: spec.objective,
			trigger,
			contradictedCardIds: this.state.retrieval.contradictedCardIds,
		});
	}

	private async retrieve(
		spec: KnowledgeQuerySpec,
		extraExcludeIds: readonly string[] = [],
	): Promise<{
		candidates: KnowledgeCardHit[];
		latencyMs: number;
		status: "ok" | "timeout" | "error";
		snapshot?: KnowledgeBaseSnapshot;
		error?: string;
	}> {
		const started = Date.now();
		const args: Record<string, unknown> = {
			query: formatQuery(spec),
			...(spec.category ? { category: spec.category } : {}),
			top_k: RETRIEVAL_TOP_K,
			exclude_ids: [...this.state.retrieval.injectedCardIds, ...extraExcludeIds],
			include_full_record: true,
			// The Python layer returns the recall set with its quality annotation;
			// applicability is decided once, here, not twice in two languages.
			include_candidates: true,
		};
		try {
			// The first call of a task pays the cold index load; later ones use the
			// steady budget because the host has the index loaded by then.
			const budget = this.state.retrieval.count === 0 ? this.firstRetrievalMs : this.hardTimeoutMs;
			const outcome = await withHardTimeout(this.options.client("attack_memory_search", args), budget);
			const latencyMs = Date.now() - started;
			if (outcome.status === "timeout") return { candidates: [], latencyMs, status: "timeout", error: "timeout" };
			if (outcome.status === "error") {
				return { candidates: [], latencyMs, status: "error", error: errorMessage(outcome.error) };
			}
			const response = outcome.value;
			if (!response.ok) {
				return { candidates: [], latencyMs, status: "error", error: response.error ?? "client_error" };
			}
			return {
				candidates: parseKnowledgeCandidates(response.data),
				latencyMs,
				status: "ok",
				snapshot: parseKnowledgeBaseSnapshot(response.data),
			};
		} catch (error) {
			return { candidates: [], latencyMs: Date.now() - started, status: "error", error: errorMessage(error) };
		}
	}

	private logDecision(
		trigger: RetrievalTrigger,
		input: {
			allowed: boolean;
			decision: string;
			queryFingerprint?: string;
			candidateCount: number;
			acceptedIds?: string[];
			rejectedReasons?: Array<{ id: string; reason: string }>;
			latencyMs: number;
			error?: string;
			gateScores?: GateAuditScore[];
			retrievalLatencyMs?: number;
			knowledgeBaseSnapshot?: KnowledgeBaseSnapshot;
			injectedCardIds?: string[];
			injectedCharacters?: number;
			injectedIntoContext?: boolean;
		},
	): void {
		this.appendAudit({
			timestamp: new Date().toISOString(),
			session_id: this.sessionId,
			task_key_hash: this.taskKeyHash,
			turn: this.options.getTurn(),
			phase: this.state.evidence.phase,
			evidence_revision: this.state.evidence.revision,
			trigger,
			allowed: input.allowed,
			category: this.state.task?.category ?? "",
			query_fingerprint: input.queryFingerprint ?? "",
			candidate_count: input.candidateCount,
			accepted_ids: input.acceptedIds ?? [],
			rejected_reasons: input.rejectedReasons ?? [],
			decision: input.decision,
			latency_ms: input.latencyMs,
			...(input.error ? { error: input.error } : {}),
			event: "knowledge_evaluated",
			...(input.gateScores && input.gateScores.length > 0 ? { gate_scores: input.gateScores } : {}),
			knowledge_base_enabled: this.options.knowledgeBaseEnabled(),
			...(input.knowledgeBaseSnapshot ? { knowledge_base_snapshot: input.knowledgeBaseSnapshot } : {}),
			...(input.retrievalLatencyMs !== undefined ? { retrieval_latency_ms: input.retrievalLatencyMs } : {}),
			...(input.injectedCardIds ? { injected_card_ids: input.injectedCardIds } : {}),
			...(input.injectedCharacters !== undefined ? { injected_characters: input.injectedCharacters } : {}),
			...(input.injectedIntoContext !== undefined ? { injected_into_context: input.injectedIntoContext } : {}),
		});
	}

	/**
	 * Audit a retrieval the model drove itself through the knowledge tool.
	 *
	 * Automatic retrieval is logged by runRetrieval. Without this entry the
	 * audit only shows what the runtime chose on its own, which makes an agent
	 * that never reaches for the knowledge base indistinguishable from one whose
	 * retrievals all came back empty.
	 */
	recordManualRetrieval(input: {
		query: string;
		ok: boolean;
		candidateCount: number;
		returnedCardIds: string[];
		injectedCharacters: number;
		snapshot?: KnowledgeBaseSnapshot;
		latencyMs: number;
		error?: string;
	}): void {
		this.logDecision("manual_tool", {
			allowed: true,
			decision: input.ok ? "model_initiated_retrieval" : "model_initiated_failed",
			queryFingerprint: input.query ? stableTaskKeyHash(input.query) : "",
			candidateCount: input.candidateCount,
			acceptedIds: input.returnedCardIds,
			latencyMs: input.latencyMs,
			retrievalLatencyMs: input.latencyMs,
			...(input.snapshot ? { knowledgeBaseSnapshot: input.snapshot } : {}),
			injectedCardIds: input.returnedCardIds,
			injectedCharacters: input.injectedCharacters,
			injectedIntoContext: input.ok && input.injectedCharacters > 0,
			...(input.error ? { error: input.error } : {}),
		});
	}

	// ------------------------------------------------------------------
	// Persistence: only normalized facts, hashes, card IDs, scores, and
	// rejection reasons are stored — never prompt text or tool output.
	// ------------------------------------------------------------------

	private runtimeDir(): string {
		return join(this.options.stateDir, "runtime", "sessions", this.sessionId || "unbound");
	}

	private statePath(): string {
		return join(this.runtimeDir(), "knowledge-state.json");
	}

	private auditPath(): string {
		return join(this.runtimeDir(), "knowledge-retrieval.jsonl");
	}

	private loadState(): void {
		const path = this.statePath();
		if (!existsSync(path)) return;
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!isRecord(parsed)) return;
			const evidence = this.state.evidence;
			if (isRecord(parsed.evidence)) {
				evidence.revision = typeof parsed.evidence.revision === "number" ? parsed.evidence.revision : 0;
				evidence.phase = stringValue(parsed.evidence.phase);
				evidence.techniques = stringArray(parsed.evidence.techniques, MAX_EVIDENCE_TECHNIQUES);
				evidence.targetFacts = stringArray(parsed.evidence.targetFacts, MAX_EVIDENCE_FACTS);
				evidence.failedRoutes = stringArray(parsed.evidence.failedRoutes, MAX_FAILED_ROUTES);
				if (typeof parsed.evidence.failureSignature === "string") {
					evidence.failureSignature = parsed.evidence.failureSignature;
				}
			}
			if (isRecord(parsed.retrieval)) {
				this.state.retrieval.bootstrapDone = parsed.retrieval.bootstrapDone === true;
				if (
					parsed.retrieval.pendingTrigger === "task_bootstrap" ||
					parsed.retrieval.pendingTrigger === "evidence_refinement" ||
					parsed.retrieval.pendingTrigger === "stall_recovery"
				) {
					this.state.retrieval.pendingTrigger = parsed.retrieval.pendingTrigger;
				}
				this.state.retrieval.count = typeof parsed.retrieval.count === "number" ? parsed.retrieval.count : 0;
				this.state.retrieval.seenQueryFingerprints = stringArray(parsed.retrieval.seenQueryFingerprints, 500);
				this.state.retrieval.injectedCardIds = stringArray(parsed.retrieval.injectedCardIds, 200);
				this.state.retrieval.contradictedCardIds = stringArray(parsed.retrieval.contradictedCardIds, 200);
				if (isRecord(parsed.retrieval.queryStates)) {
					// Backward compatibility: v1 persisted only a fingerprint list,
					// which is restored as permanent success entries.
					for (const fingerprint of this.state.retrieval.seenQueryFingerprints) {
						this.state.retrieval.queryStates[fingerprint] = {
							status: "success",
							attempts: 1,
							revision: evidence.revision,
							turn: 0,
						};
					}
					for (const [fingerprint, raw] of Object.entries(parsed.retrieval.queryStates)) {
						if (!isRecord(raw)) continue;
						const status = raw.status;
						if (status !== "success" && status !== "empty" && status !== "timeout" && status !== "error") {
							continue;
						}
						this.state.retrieval.queryStates[fingerprint] = {
							status,
							attempts: typeof raw.attempts === "number" ? raw.attempts : 1,
							revision: typeof raw.revision === "number" ? raw.revision : evidence.revision,
							turn: typeof raw.turn === "number" ? raw.turn : 0,
						};
					}
				}
				this.state.retrieval.recoveryEpoch =
					typeof parsed.retrieval.recoveryEpoch === "number" ? parsed.retrieval.recoveryEpoch : 0;
				if (typeof parsed.retrieval.refinedForRevision === "number") {
					this.state.retrieval.refinedForRevision = parsed.retrieval.refinedForRevision;
				}
			}
			if (isRecord(parsed.task)) {
				this.taskKeyHash = stringValue(parsed.task.keyHash);
				const sourceValue = parsed.task.source;
				this.state.task = {
					key: "",
					source:
						sourceValue === "competition" || sourceValue === "explicit" || sourceValue === "descriptor"
							? sourceValue
							: "descriptor",
					solveMode: parsed.task.solveMode === true,
					category: normalizeAttackCategory(stringValue(parsed.task.category)),
					objective: "",
				};
			}
		} catch {
			// Corrupt or unreadable state must never block the agent.
		}
	}

	private persistState(): void {
		if (!this.sessionId) return;
		const persisted: PersistedSolveKnowledgeState = {
			...(this.state.task
				? {
						task: {
							keyHash: this.taskKeyHash,
							source: this.state.task.source,
							solveMode: this.state.task.solveMode,
							...(this.state.task.category ? { category: this.state.task.category } : {}),
						},
					}
				: {}),
			evidence: this.state.evidence,
			retrieval: {
				bootstrapDone: this.state.retrieval.bootstrapDone,
				...(this.state.retrieval.pendingTrigger ? { pendingTrigger: this.state.retrieval.pendingTrigger } : {}),
				count: this.state.retrieval.count,
				seenQueryFingerprints: this.state.retrieval.seenQueryFingerprints.slice(-500),
				queryStates: Object.fromEntries(Object.entries(this.state.retrieval.queryStates).slice(-500)),
				contradictedCardIds: this.state.retrieval.contradictedCardIds.slice(-200),
				injectedCardIds: this.state.retrieval.injectedCardIds.slice(-200),
				recoveryEpoch: this.state.retrieval.recoveryEpoch,
				...(this.state.retrieval.refinedForRevision === undefined
					? {}
					: { refinedForRevision: this.state.retrieval.refinedForRevision }),
			},
		};
		const path = this.statePath();
		try {
			mkdirSync(this.runtimeDir(), { recursive: true });
			const temporary = `${path}.tmp`;
			writeFileSync(temporary, JSON.stringify(persisted), "utf8");
			renameSync(temporary, path);
		} catch {
			// Persistence failures are audit-only and never block the agent.
		}
	}

	private appendAudit(entry: KnowledgeAuditEntry): void {
		if (!this.sessionId) return;
		try {
			mkdirSync(this.runtimeDir(), { recursive: true });
			appendFileSync(this.auditPath(), `${JSON.stringify(entry)}\n`, "utf8");
		} catch {
			// Audit write failures are ignored.
		}
	}
}

export type HardTimeoutResult<T> =
	| { status: "ok"; value: T }
	| { status: "timeout" }
	| { status: "error"; error: unknown };

/**
 * Race a promise against a hard timeout without aborting the underlying call:
 * aborting the legacy host would kill the shared Python worker, so the late
 * result is simply ignored (fail-open). Client rejections are swallowed and
 * reported so the underlying call never becomes an unhandled rejection.
 */
export async function withHardTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<HardTimeoutResult<T>> {
	const guarded = promise.then(
		(value): HardTimeoutResult<T> => ({ status: "ok", value }),
		(error: unknown): HardTimeoutResult<T> => ({ status: "error", error }),
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), timeoutMs);
	});
	try {
		const outcome = await Promise.race([guarded, timeout]);
		if (outcome === undefined) return { status: "timeout" };
		return outcome;
	} finally {
		if (timer) clearTimeout(timer);
	}
}
