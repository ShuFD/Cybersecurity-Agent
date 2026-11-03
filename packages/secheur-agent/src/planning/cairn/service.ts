/** Adapted from sxd-git1/cairnpilot b015733fa117aa35f2406b8b31fd1bbf84d3ec6e.
 * Apache-2.0; see vendor/cairnpilot/LICENSE and NOTICE.md. */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { constants, mkdirSync, readFileSync, type Stats, writeFileSync } from "node:fs";
import { copyFile, link, lstat, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	buildFocusedContext,
	buildIntentFocusedContext,
	FOCUSED_CONTEXT_MAX_LIMITS,
	type FocusedContextLimits,
} from "./context-builder.ts";
import { buildReasonContext } from "./reason-context-builder.ts";
import {
	type ParsedReasonProposal,
	validateReasonProposal as validateReasonProposalDomain,
} from "./reason-proposal.ts";
import { GraphStore } from "./store.ts";
import type {
	ChallengeGraphSnapshot,
	FactCandidate,
	FactKind,
	FocusedGraphContext,
	GraphActor,
	GraphArtifact,
	GraphDelta,
	GraphFact,
	GraphHint,
	GraphIntent,
	IntentCandidate,
	IntentCheckpointResult,
	IntentClaim,
	IntentConcludeResult,
	IntentLease,
	IntentOutcome,
	IntentResultFactInput,
	ReasonContextEnvelope,
	ReasonLease,
	ReasonLeaseRecord,
	ReasonProposal,
	ReasonProposalApplyResult,
	ReasonProposalSkippedIntent,
	ReasonProposalSkippedSupersede,
	ReasonTrigger,
	ReasonTriggerReason,
} from "./types.ts";

export type GraphErrorType = "validation" | "forbidden" | "conflict" | "not_found" | "internal";

export class GraphServiceError extends Error {
	readonly type: GraphErrorType;
	constructor(type: GraphErrorType, message: string) {
		super(message);
		this.name = "GraphServiceError";
		this.type = type;
	}
}

interface CommandBase {
	actor: GraphActor;
	idempotencyKey: string;
	createdAt: string;
}

export interface ProposeFactInput extends CommandBase {
	kind: FactKind;
	statement: string;
	confidence: number;
	evidenceRefs?: string[];
	sourceEventIds?: string[];
}

export interface ConfirmFactInput extends CommandBase {
	candidateId: string;
}

export interface ProposeIntentInput extends CommandBase {
	objective: string;
	scope: string;
	confidence: number;
	fromFactIds?: string[];
	sourceHintIds?: string[];
	capabilityTags?: string[];
	sourceEventIds?: string[];
}

export interface ConfirmIntentInput extends CommandBase {
	candidateId: string;
}

export interface AppendFactEvidenceInput extends CommandBase {
	factId: string;
	evidenceRef: string;
}

export interface InvalidateFactInput extends CommandBase {
	factId: string;
	replacementFactId: string;
}

export interface AddHintInput extends CommandBase {
	content: string;
}

export interface RegisterArtifactInput extends CommandBase {
	relativePath: string;
	solverWorkspacePath: string;
	sha256: string;
	size: number;
	mimeType: string;
	intentId?: string;
}

export interface LeaseCommandInput {
	actor: GraphActor;
	idempotencyKey: string;
	intentId: string;
	token: string;
	generation: number;
	expectedVersion: number;
}

export interface ReleaseClaimForRuntimeFailureInput {
	actor: GraphActor;
	idempotencyKey: string;
	intentId: string;
	solverId: string;
	generation: number;
	expectedVersion: number;
}

export interface SchedulerGraphState {
	graph: ChallengeGraphSnapshot;
	activeClaims: IntentClaim[];
}

export interface ResultSubmissionInput {
	facts?: IntentResultFactInput[];
	factIds?: string[];
	artifactIds?: string[];
}

export interface GraphServiceOptions {
	artifactRoot?: string;
	copyArtifactFile?: (sourcePath: string, temporaryPath: string) => Promise<void>;
	createArtifactDirectory?: (path: string) => Promise<void>;
	clock?: { now(): Date };
	tokenFactory?: () => string;
	leaseTokenSecret?: string | Uint8Array;
	reasonerEnabled?: boolean;
	maxReasonAttempts?: number;
}

export interface PersistReasonProposalInput extends CommandBase, ParsedReasonProposal {
	ownerId: string;
	generation: number;
	token: string;
	sourceTriggerIds: string[];
	baseEventSequence: number;
	contextFingerprint: string;
	model: string;
	provider: string;
	promptVersion: string;
	validationErrors?: string[];
}

export interface ApplyReasonProposalInput extends CommandBase {
	proposalId: string;
}

export const GRAPH_DELTA_PAGE_SIZE = 32;
export const MIN_LEASE_DURATION_MS = 5_000;
export const MAX_LEASE_DURATION_MS = 300_000;
export const MAX_REASON_TRIGGER_CLAIM = 16;
export const MAX_REASON_TRIGGER_BATCH = 256;
export const MAX_REASON_ATTEMPTS = 5;
export const MIN_REASON_LEASE_DURATION_MS = 5_000;
export const MAX_REASON_LEASE_DURATION_MS = 300_000;

const artifactOperationLocks = new Map<string, Promise<void>>();
const ACTIVE_INTENT_STATUSES: ReadonlySet<GraphIntent["status"]> = new Set(["open", "claimed", "running", "blocked"]);
const SUPERSEDABLE_INTENT_STATUSES: ReadonlySet<GraphIntent["status"]> = new Set(["open", "blocked"]);

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, stableValue(item)]),
	);
}

function digest(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(stableValue(value)))
		.digest("hex");
}

function generatedId(prefix: string, challengeId: string, operation: string, idempotencyKey: string): string {
	return `${prefix}_${digest([challengeId, operation, idempotencyKey]).slice(0, 24)}`;
}

function requireTimestamp(value: string): string {
	if (!value.trim() || !Number.isFinite(Date.parse(value))) {
		throw new GraphServiceError("validation", "createdAt must be a valid timestamp");
	}
	return value;
}

function requireText(value: string, field: string): string {
	const text = value.trim();
	if (!text) throw new GraphServiceError("validation", `${field} is required`);
	return text;
}

function requireConfidence(value: number): number {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new GraphServiceError("validation", "confidence must be between 0 and 1");
	}
	return value;
}

const FACT_KINDS = new Set<FactKind>([
	"origin",
	"goal",
	"fact",
	"evidence",
	"failure_boundary",
	"credential",
	"asset",
	"flag",
	"constraint",
]);

function unique(values: string[] | undefined): string[] {
	return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizeTextForFingerprint(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeCriteria(values: string[]): string[] {
	return unique(values.map(normalizeTextForFingerprint));
}

function reasonIntentFingerprint(input: {
	challengeId: string;
	objective: string;
	fromFactIds: string[];
	sourceHintIds: string[];
	capabilityTags: string[];
	successCriteria: string[];
}): string {
	return digest({
		challengeId: input.challengeId,
		objective: normalizeTextForFingerprint(input.objective),
		fromFactIds: unique(input.fromFactIds),
		sourceHintIds: unique(input.sourceHintIds),
		capabilityTags: unique(input.capabilityTags.map((tag) => normalizeTextForFingerprint(tag))),
		successCriteria: normalizeCriteria(input.successCriteria),
	});
}

function existingIntentFingerprint(intent: GraphIntent): string {
	return reasonIntentFingerprint({
		challengeId: intent.challengeId,
		objective: intent.objective,
		fromFactIds: intent.fromFactIds,
		sourceHintIds: intent.sourceHintIds,
		capabilityTags: intent.capabilityTags,
		successCriteria: intent.scope.split(/\r?\n/).filter(Boolean),
	});
}

function isPathInside(root: string, target: string): boolean {
	const pathFromRoot = relative(root, target);
	return (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
	);
}

function requireSafeInteger(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new GraphServiceError("validation", `${field} must be a non-negative safe integer`);
	}
	return value;
}

function boundedLimit(value: number | undefined, field: keyof FocusedContextLimits, maximum: number): number {
	if (value === undefined) return maximum;
	return Math.min(requireSafeInteger(value, field), maximum);
}

async function assertPathHasNoLinks(root: string, relativePath: string, allowMissingLeaf = false): Promise<void> {
	const segments = relativePath.split(/[\\/]+/).filter(Boolean);
	let current = root;
	const rootStats = await lstat(root);
	if (rootStats.isSymbolicLink())
		throw new GraphServiceError("forbidden", "path root cannot be a symlink or junction");
	for (let index = 0; index < segments.length; index += 1) {
		current = resolve(current, segments[index]);
		try {
			const stats = await lstat(current);
			if (stats.isSymbolicLink()) {
				throw new GraphServiceError("forbidden", "artifact path cannot contain a symlink or junction");
			}
		} catch (error) {
			if (
				allowMissingLeaf &&
				index === segments.length - 1 &&
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				return;
			}
			throw error;
		}
	}
}

async function requireRealDirectory(path: string): Promise<void> {
	const stats = await lstat(path);
	if (stats.isSymbolicLink()) {
		throw new GraphServiceError("forbidden", "artifact directory cannot be a symlink or junction");
	}
	if (!stats.isDirectory()) throw new GraphServiceError("validation", "artifact path parent must be a directory");
}

async function mkdirWithoutLinks(
	root: string,
	relativePath: string,
	createDirectory: (path: string) => Promise<void> = (path) => mkdir(path),
): Promise<void> {
	const segments = relativePath.split(/[\\/]+/).filter(Boolean);
	let current = root;
	for (const segment of segments) {
		current = resolve(current, segment);
		try {
			await requireRealDirectory(current);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				try {
					await createDirectory(current);
				} catch (mkdirError) {
					if (
						!mkdirError ||
						typeof mkdirError !== "object" ||
						!("code" in mkdirError) ||
						mkdirError.code !== "EEXIST"
					) {
						throw mkdirError;
					}
					await requireRealDirectory(current);
				}
				continue;
			}
			throw error;
		}
	}
}

async function withArtifactOperationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous = artifactOperationLocks.get(key) ?? Promise.resolve();
	let release = () => {};
	const current = new Promise<void>((resolveCurrent) => {
		release = resolveCurrent;
	});
	const tail = previous.then(() => current);
	artifactOperationLocks.set(key, tail);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (artifactOperationLocks.get(key) === tail) artifactOperationLocks.delete(key);
	}
}

export class GraphService {
	private readonly store: GraphStore;
	private readonly artifactRoot: string;
	private readonly copyArtifactFile: (sourcePath: string, temporaryPath: string) => Promise<void>;
	private readonly createArtifactDirectory: (path: string) => Promise<void>;
	private readonly clock: { now(): Date };
	private readonly leaseTokenSecret: string | Uint8Array;
	private readonly reasonerEnabled: boolean;
	private readonly maxReasonAttempts: number;

	constructor(store: GraphStore, options: GraphServiceOptions = {}) {
		this.store = store;
		this.artifactRoot = options.artifactRoot ?? resolve(homedir(), ".secheur-agent/cairn", "challenges");
		this.copyArtifactFile =
			options.copyArtifactFile ??
			((sourcePath, temporaryPath) => copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL));
		this.createArtifactDirectory = options.createArtifactDirectory ?? ((path) => mkdir(path));
		this.clock = options.clock ?? { now: () => new Date() };
		this.leaseTokenSecret = options.leaseTokenSecret ?? options.tokenFactory?.() ?? randomUUID();
		this.reasonerEnabled = options.reasonerEnabled === true;
		this.maxReasonAttempts = options.maxReasonAttempts ?? MAX_REASON_ATTEMPTS;
		if (!Number.isSafeInteger(this.maxReasonAttempts) || this.maxReasonAttempts < 1)
			throw new Error("Invalid maxReasonAttempts");
	}

	proposeFact(input: ProposeFactInput): FactCandidate {
		if (!FACT_KINDS.has(input.kind)) throw new GraphServiceError("validation", "kind is not a supported Fact kind");
		const statement = requireText(input.statement, "statement");
		const createdAt = requireTimestamp(input.createdAt);
		const candidate: FactCandidate = {
			id: generatedId("fact_candidate", input.actor.challengeId, "proposeFact", input.idempotencyKey),
			challengeId: input.actor.challengeId,
			kind: input.kind,
			statement,
			confidence: requireConfidence(input.confidence),
			evidenceRefs: unique(input.evidenceRefs),
			sourceEventIds: unique(input.sourceEventIds),
			sourceActorId: input.actor.id,
			sourceRole: input.actor.role,
			status: "proposed",
			createdAt,
			updatedAt: createdAt,
		};
		return this.idempotent("proposeFact", input, () => {
			this.store.insertFactCandidate(candidate);
			this.event(candidate.challengeId, "fact_candidate_proposed", candidate.id, input, candidate);
			return candidate;
		});
	}

	confirmFact(input: ConfirmFactInput): GraphFact {
		this.requireHost(input.actor);
		return this.idempotent("confirmFact", input, () => {
			const candidate = this.store.readFactCandidate(input.actor.challengeId, input.candidateId);
			if (!candidate) throw new GraphServiceError("not_found", `fact candidate ${input.candidateId} was not found`);
			if (candidate.status !== "proposed") throw new GraphServiceError("conflict", "fact candidate is not proposed");
			const fact: GraphFact = {
				id: generatedId("fact", input.actor.challengeId, "confirmFact", input.idempotencyKey),
				challengeId: input.actor.challengeId,
				kind: candidate.kind,
				statement: candidate.statement,
				evidenceRefs: candidate.evidenceRefs,
				sourceSolverId: candidate.sourceRole === "solver" ? candidate.sourceActorId : undefined,
				sourceMemoryIds: [],
				fingerprint: digest([input.actor.challengeId, candidate.kind, candidate.statement]),
				status: "active",
				observedAt: candidate.createdAt,
				createdAt: requireTimestamp(input.createdAt),
			};
			this.store.insertServiceFact(fact);
			this.store.confirmFactCandidate(input.actor.challengeId, candidate.id, fact.id, input.createdAt);
			const sequence = this.event(fact.challengeId, "fact_confirmed", fact.id, input, {
				candidateId: candidate.id,
				fact,
			});
			this.trigger(
				"fact_confirmed",
				fact.challengeId,
				fact.id,
				sequence,
				{ candidateId: candidate.id, fact },
				input.createdAt,
			);
			return fact;
		});
	}

	addHint(input: AddHintInput): GraphHint {
		this.requireHost(input.actor, "Hint creation");
		return this.idempotent("addHint", input, () => {
			const content = requireText(input.content, "content");
			const hint: GraphHint = {
				id: generatedId("hint", input.actor.challengeId, "addHint", input.idempotencyKey),
				challengeId: input.actor.challengeId,
				content,
				creator: input.actor.id,
				sourceMemoryIds: [],
				fingerprint: digest([input.actor.challengeId, content.trim().replace(/\s+/g, " ").toLowerCase()]),
				createdAt: requireTimestamp(input.createdAt),
			};
			this.store.insertServiceHint(hint);
			const sequence = this.event(hint.challengeId, "hint_added", hint.id, input, hint);
			this.trigger("hint_added", hint.challengeId, hint.id, sequence, hint, input.createdAt);
			return hint;
		});
	}

	proposeIntent(input: ProposeIntentInput): IntentCandidate {
		const candidate: IntentCandidate = {
			id: generatedId("intent_candidate", input.actor.challengeId, "proposeIntent", input.idempotencyKey),
			challengeId: input.actor.challengeId,
			objective: requireText(input.objective, "objective"),
			scope: requireText(input.scope, "scope"),
			confidence: requireConfidence(input.confidence),
			fromFactIds: unique(input.fromFactIds),
			sourceHintIds: unique(input.sourceHintIds),
			capabilityTags: unique(input.capabilityTags),
			sourceEventIds: unique(input.sourceEventIds),
			sourceActorId: input.actor.id,
			sourceRole: input.actor.role,
			status: "proposed",
			createdAt: requireTimestamp(input.createdAt),
			updatedAt: input.createdAt,
		};
		return this.idempotent("proposeIntent", input, () => {
			this.validateIntentReferences(candidate);
			this.store.insertIntentCandidate(candidate);
			this.event(candidate.challengeId, "intent_candidate_proposed", candidate.id, input, candidate);
			return candidate;
		});
	}

	confirmIntent(input: ConfirmIntentInput): GraphIntent {
		this.requireHost(input.actor);
		return this.idempotent("confirmIntent", input, () => {
			const candidate = this.store.readIntentCandidate(input.actor.challengeId, input.candidateId);
			if (!candidate)
				throw new GraphServiceError("not_found", `intent candidate ${input.candidateId} was not found`);
			if (candidate.status !== "proposed")
				throw new GraphServiceError("conflict", "intent candidate is not proposed");
			this.validateIntentReferences(candidate);
			const intent: GraphIntent = {
				id: generatedId("intent", input.actor.challengeId, "confirmIntent", input.idempotencyKey),
				challengeId: input.actor.challengeId,
				fromFactIds: candidate.fromFactIds,
				sourceHintIds: candidate.sourceHintIds,
				objective: candidate.objective,
				scope: candidate.scope,
				capabilityTags: candidate.capabilityTags,
				priority: 0,
				status: "open",
				resultFactIds: [],
				attemptCount: 0,
				version: 1,
				createdBy: input.actor.id,
				sourceIdeaIds: [],
				fingerprint: digest([input.actor.challengeId, candidate.objective, candidate.scope]),
				createdAt: requireTimestamp(input.createdAt),
				updatedAt: input.createdAt,
			};
			this.store.insertServiceIntent(intent);
			this.store.confirmIntentCandidate(input.actor.challengeId, candidate.id, intent.id, input.createdAt);
			this.event(intent.challengeId, "intent_confirmed", intent.id, input, { candidateId: candidate.id, intent });
			return intent;
		});
	}

	appendFactEvidence(input: AppendFactEvidenceInput): { factId: string; evidenceRef: string; appended: boolean } {
		const evidenceRef = requireText(input.evidenceRef, "evidenceRef");
		return this.idempotent("appendFactEvidence", input, () => {
			const appended = this.store.appendServiceFactEvidence(input.actor.challengeId, input.factId, evidenceRef);
			const result = { factId: input.factId, evidenceRef, appended };
			this.event(input.actor.challengeId, "fact_evidence_appended", input.factId, input, result);
			return result;
		});
	}

	invalidateFact(input: InvalidateFactInput): { factId: string; replacementFactId: string } {
		this.requireHost(input.actor, "Fact invalidation");
		return this.idempotent("invalidateFact", input, () => {
			this.store.invalidateServiceFact(input.actor.challengeId, input.factId, input.replacementFactId);
			const result = { factId: input.factId, replacementFactId: input.replacementFactId };
			const sequence = this.event(input.actor.challengeId, "fact_invalidated", input.factId, input, result);
			this.trigger("fact_invalidated", input.actor.challengeId, input.factId, sequence, result, input.createdAt);
			return result;
		});
	}

	async registerArtifact(input: RegisterArtifactInput): Promise<GraphArtifact> {
		requireText(input.idempotencyKey, "idempotencyKey");
		const lockKey = JSON.stringify([input.actor.challengeId, "registerArtifact", input.idempotencyKey]);
		return withArtifactOperationLock(lockKey, () => this.registerArtifactLocked(input));
	}

	claimIntent(input: {
		actor: GraphActor;
		idempotencyKey: string;
		intentId: string;
		solverId: string;
		expectedVersion: number;
		leaseDurationMs: number;
	}): IntentLease {
		this.requireHost(input.actor, "Intent claim");
		const now = this.now();
		const command = { ...input, createdAt: now };
		return this.idempotent(
			"claimIntent",
			command,
			() => {
				const intent = this.requireActiveChallengeIntent(input.actor.challengeId, input.intentId);
				if (intent.status !== "open") throw new GraphServiceError("conflict", "intent is not open");
				if (intent.version !== requireSafeInteger(input.expectedVersion, "expectedVersion")) {
					throw new GraphServiceError("conflict", "intent version conflict");
				}
				const leaseDurationMs = this.requireLeaseDuration(input.leaseDurationMs);
				if (this.store.readActiveClaimByIntent(intent.challengeId, intent.id)) {
					throw new GraphServiceError("conflict", "intent already has an active claim");
				}
				if (this.store.readActiveClaimBySolver(input.solverId)) {
					throw new GraphServiceError("conflict", "solver already owns a primary intent");
				}
				this.store.registerLeaseSolver(intent.challengeId, requireText(input.solverId, "solverId"), now);
				const generation = this.store.nextClaimGeneration(intent.challengeId, intent.id);
				const token = this.deriveLeaseToken(
					intent.challengeId,
					intent.id,
					input.solverId,
					generation,
					input.idempotencyKey,
				);
				const leaseUntil = new Date(Date.parse(now) + leaseDurationMs).toISOString();
				const claim: IntentClaim = {
					id: generatedId("claim", intent.challengeId, intent.id, String(generation)),
					challengeId: intent.challengeId,
					intentId: intent.id,
					solverId: input.solverId,
					tokenHash: digest(token),
					generation,
					leaseUntil,
					heartbeatAt: now,
					status: "active",
					createdAt: now,
					updatedAt: now,
				};
				const version = this.store.updateIntentLeaseState({
					challengeId: intent.challengeId,
					intentId: intent.id,
					expectedVersion: intent.version,
					status: "claimed",
					ownerSolverId: input.solverId,
					leaseUntil,
					updatedAt: now,
					incrementAttempt: true,
				});
				this.store.insertIntentClaim(claim);
				const result = {
					challengeId: intent.challengeId,
					intentId: intent.id,
					solverId: input.solverId,
					token,
					generation,
					leaseUntil,
					version,
				};
				this.event(intent.challengeId, "intent_claimed", intent.id, command, {
					solverId: input.solverId,
					generation,
					leaseUntil,
					version,
				});
				return result;
			},
			input,
			{
				persist: ({ token: _token, ...result }) => result,
				restore: (result) => ({
					...(result as Omit<IntentLease, "token">),
					token: this.deriveLeaseToken(
						input.actor.challengeId,
						input.intentId,
						input.solverId,
						(result as Omit<IntentLease, "token">).generation,
						input.idempotencyKey,
					),
				}),
			},
		);
	}

	readSchedulerState(challengeId: string): SchedulerGraphState {
		const id = requireText(challengeId, "challengeId");
		return {
			graph: this.store.readServiceGraph(id),
			activeClaims: this.store.readClaims(id).filter((claim) => claim.status === "active"),
		};
	}

	listSchedulerWorkChallenges(limit = 32): string[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
			throw new GraphServiceError("validation", "limit must be between 1 and 256");
		}
		return this.store.readSchedulerChallengeIds(limit);
	}

	acknowledgeIntent(input: LeaseCommandInput): IntentLease {
		return this.leaseTransition("acknowledgeIntent", input, "claimed", (intent, claim, now) => {
			const version = this.store.updateIntentLeaseState({
				challengeId: intent.challengeId,
				intentId: intent.id,
				expectedVersion: intent.version,
				status: "running",
				ownerSolverId: claim.solverId,
				leaseUntil: claim.leaseUntil,
				updatedAt: now,
			});
			return { ...this.publicLease(claim, input.token), version };
		});
	}

	heartbeatIntent(input: LeaseCommandInput & { leaseDurationMs: number }): IntentLease {
		const now = this.now();
		return this.idempotent(
			"heartbeatIntent",
			{ ...input, createdAt: now },
			() => {
				const { intent, claim } = this.requireLease(input, now);
				const duration = this.requireLeaseDuration(input.leaseDurationMs);
				const requested = new Date(Date.parse(now) + duration).toISOString();
				const leaseUntil = Date.parse(requested) > Date.parse(claim.leaseUntil) ? requested : claim.leaseUntil;
				this.store.updateActiveClaim(claim.id, { leaseUntil, heartbeatAt: now, updatedAt: now });
				const version = this.store.renewIntentLease(intent.challengeId, intent.id, intent.version, leaseUntil, now);
				this.event(
					intent.challengeId,
					"intent_heartbeat",
					intent.id,
					{ ...input, createdAt: now },
					{
						solverId: claim.solverId,
						generation: claim.generation,
						leaseUntil,
						version,
					},
				);
				return { ...this.publicLease({ ...claim, leaseUntil }, input.token), version };
			},
			input,
			this.leaseResultCodec(input.token),
		);
	}

	checkpointIntent(input: LeaseCommandInput & ResultSubmissionInput): IntentCheckpointResult {
		return this.completeIntentTransaction("checkpointIntent", input, false) as IntentCheckpointResult;
	}

	concludeIntent(input: LeaseCommandInput & ResultSubmissionInput & { outcome: IntentOutcome }): IntentConcludeResult {
		if (!["success", "partial", "failure", "inconclusive"].includes(input.outcome)) {
			throw new GraphServiceError("validation", "invalid intent outcome");
		}
		return this.completeIntentTransaction("concludeIntent", input, true) as IntentConcludeResult;
	}

	releaseIntent(input: LeaseCommandInput): { intentId: string; version: number; released: true } {
		const now = this.now();
		return this.idempotent(
			"releaseIntent",
			{ ...input, createdAt: now },
			() => {
				const { intent, claim } = this.requireLease(input, now);
				this.store.updateActiveClaim(claim.id, { status: "released", updatedAt: now });
				const version = this.store.updateIntentLeaseState({
					challengeId: intent.challengeId,
					intentId: intent.id,
					expectedVersion: intent.version,
					status: "open",
					updatedAt: now,
				});
				const result = { intentId: intent.id, version, released: true as const };
				this.event(
					intent.challengeId,
					"intent_released",
					intent.id,
					{ ...input, createdAt: now },
					{
						solverId: claim.solverId,
						generation: claim.generation,
						version,
					},
				);
				return result;
			},
			input,
		);
	}

	releaseClaimForRuntimeFailure(input: ReleaseClaimForRuntimeFailureInput): {
		intentId: string;
		version: number;
		released: true;
	} {
		this.requireHost(input.actor, "Runtime launch compensation");
		const now = this.now();
		return this.idempotent(
			"releaseClaimForRuntimeFailure",
			{ ...input, createdAt: now },
			() => {
				const intent = this.requireActiveChallengeIntent(input.actor.challengeId, input.intentId);
				if (intent.status !== "claimed") throw new GraphServiceError("conflict", "intent is not claimed");
				if (intent.version !== requireSafeInteger(input.expectedVersion, "expectedVersion")) {
					throw new GraphServiceError("conflict", "intent version conflict");
				}
				const claim = this.store.readActiveClaimByIntent(intent.challengeId, intent.id);
				if (!claim) throw new GraphServiceError("conflict", "active Claim was not found");
				if (claim.solverId !== requireText(input.solverId, "solverId")) {
					throw new GraphServiceError("conflict", "Claim owner mismatch");
				}
				if (claim.generation !== requireSafeInteger(input.generation, "generation")) {
					throw new GraphServiceError("conflict", "Claim generation is stale");
				}
				this.store.updateActiveClaim(claim.id, { status: "released", updatedAt: now });
				const version = this.store.updateIntentLeaseState({
					challengeId: intent.challengeId,
					intentId: intent.id,
					expectedVersion: intent.version,
					status: "open",
					updatedAt: now,
				});
				const result = { intentId: intent.id, version, released: true as const };
				this.event(
					intent.challengeId,
					"intent_released",
					intent.id,
					{ ...input, createdAt: now },
					{
						solverId: claim.solverId,
						generation: claim.generation,
						version,
						reason: "runtime_launch_failed",
					},
				);
				return result;
			},
			input,
		);
	}

	expireLeases(challengeId?: string): { expired: number } {
		const now = this.now();
		return this.store.executeServiceTransaction(() => {
			let expired = 0;
			for (const claim of this.store.readExpiredActiveClaims(now, challengeId)) {
				const intent = this.store.readIntentForLease(claim.challengeId, claim.intentId);
				if (!intent || !["claimed", "running"].includes(intent.status)) continue;
				this.store.updateActiveClaim(claim.id, { status: "expired", updatedAt: now });
				const version = this.store.updateIntentLeaseState({
					challengeId: intent.challengeId,
					intentId: intent.id,
					expectedVersion: intent.version,
					status: "open",
					updatedAt: now,
				});
				this.store.appendServiceEvent({
					challengeId: intent.challengeId,
					type: "intent_lease_expired",
					entityId: intent.id,
					actorId: "host",
					idempotencyKey: `lease-expired:${claim.id}`,
					payload: { solverId: claim.solverId, generation: claim.generation, version },
					createdAt: now,
				});
				expired += 1;
			}
			return { expired };
		});
	}

	cancelActiveIntents(challengeId: string): { cancelled: number } {
		const now = this.now();
		return this.store.executeServiceTransaction(() => {
			const completionChanged = this.store.markChallengeCompleted(challengeId, now);
			let cancelled = 0;
			for (const intent of this.store.readServiceGraph(challengeId).intents) {
				if (!["claimed", "running", "blocked"].includes(intent.status)) continue;
				const claim = this.store.readActiveClaimByIntent(challengeId, intent.id);
				if (claim) this.store.updateActiveClaim(claim.id, { status: "cancelled", updatedAt: now });
				const version = this.store.updateIntentLeaseState({
					challengeId,
					intentId: intent.id,
					expectedVersion: intent.version,
					status: "cancelled",
					updatedAt: now,
				});
				this.store.appendServiceEvent({
					challengeId,
					type: "intent_cancelled",
					entityId: intent.id,
					actorId: "host",
					idempotencyKey: `challenge-completed:${challengeId}:${intent.id}`,
					payload: { version },
					createdAt: now,
				});
				cancelled += 1;
			}
			if (completionChanged) {
				this.store.appendServiceEvent({
					challengeId,
					type: "challenge_completed",
					entityId: challengeId,
					actorId: "host",
					idempotencyKey: `challenge-completed:${challengeId}`,
					payload: { cancelled },
					createdAt: now,
				});
			}
			return { cancelled };
		});
	}

	acquireReasonLease(input: CommandBase & { ownerId: string; leaseDurationMs: number }): ReasonLease {
		this.requireReasoner();
		this.requireHost(input.actor, "Reason Lease acquisition");
		const now = this.now();
		return this.idempotent(
			"acquireReasonLease",
			{ ...input, createdAt: now },
			() => {
				const challengeId = input.actor.challengeId;
				const graph = this.store.readServiceGraph(challengeId);
				if (graph.goalState?.completed) throw new GraphServiceError("conflict", "challenge is completed");
				if (this.store.readActiveReasonLease(challengeId)) {
					throw new GraphServiceError("conflict", "challenge already has an active Reason Lease");
				}
				const ownerId = requireText(input.ownerId, "ownerId");
				const generation = this.store.nextReasonLeaseGeneration(challengeId);
				const duration = this.requireReasonLeaseDuration(input.leaseDurationMs);
				const leaseUntil = new Date(Date.parse(now) + duration).toISOString();
				const token = this.deriveReasonLeaseToken(challengeId, ownerId, generation, input.idempotencyKey);
				this.store.insertReasonLease({
					challengeId,
					ownerId,
					generation,
					tokenHash: digest(token),
					leaseUntil,
					heartbeatAt: now,
					status: "active",
					createdAt: now,
					updatedAt: now,
				});
				return { challengeId, ownerId, generation, token, leaseUntil };
			},
			input,
			{
				persist: ({ token: _token, ...result }) => result,
				restore: (result) => ({
					...(result as Omit<ReasonLease, "token">),
					token: this.deriveReasonLeaseToken(
						input.actor.challengeId,
						input.ownerId,
						(result as Omit<ReasonLease, "token">).generation,
						input.idempotencyKey,
					),
				}),
			},
		);
	}

	heartbeatReasonLease(
		input: CommandBase & { ownerId: string; generation: number; token: string; leaseDurationMs: number },
	): ReasonLease {
		this.requireReasoner();
		this.requireHost(input.actor, "Reason Lease heartbeat");
		const now = this.now();
		return this.idempotent(
			"heartbeatReasonLease",
			{ ...input, createdAt: now },
			() => {
				const lease = this.requireReasonLease(input, now);
				const requested = new Date(
					Date.parse(now) + this.requireReasonLeaseDuration(input.leaseDurationMs),
				).toISOString();
				const leaseUntil = Date.parse(requested) > Date.parse(lease.leaseUntil) ? requested : lease.leaseUntil;
				this.store.updateActiveReasonLease(lease.challengeId, lease.generation, {
					leaseUntil,
					heartbeatAt: now,
					updatedAt: now,
				});
				return {
					challengeId: lease.challengeId,
					ownerId: lease.ownerId,
					generation: lease.generation,
					token: input.token,
					leaseUntil,
				};
			},
			input,
			{
				persist: ({ token: _token, ...result }) => result,
				restore: (result) => ({ ...(result as Omit<ReasonLease, "token">), token: input.token }),
			},
		);
	}

	releaseReasonLease(input: CommandBase & { ownerId: string; generation: number; token: string }): {
		released: true;
		generation: number;
		recovered: number;
	} {
		this.requireReasoner();
		this.requireHost(input.actor, "Reason Lease release");
		const now = this.now();
		return this.idempotent(
			"releaseReasonLease",
			{ ...input, createdAt: now },
			() => {
				const lease = this.requireReasonLease(input, now);
				const result = this.store.releaseReasonLeaseRows(lease.challengeId, lease.generation, now);
				return { ...result, generation: lease.generation };
			},
			input,
		);
	}

	expireReasonLeases(): { expired: number; recovered: number } {
		this.requireReasoner();
		const now = this.now();
		return this.store.executeServiceTransaction(() => this.store.expireReasonLeaseRows(now));
	}

	claimReasonTriggers(
		input: CommandBase & {
			ownerId: string;
			generation: number;
			token: string;
			limit?: number;
		},
	): ReasonTrigger[] {
		this.requireReasoner();
		this.requireHost(input.actor, "Reason Trigger claim");
		const now = this.now();
		return this.idempotent(
			"claimReasonTriggers",
			{ ...input, createdAt: now },
			() => {
				const lease = this.requireReasonLease(input, now);
				const limit = input.limit ?? MAX_REASON_TRIGGER_CLAIM;
				if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_REASON_TRIGGER_CLAIM) {
					throw new GraphServiceError("validation", `limit must be between 1 and ${MAX_REASON_TRIGGER_CLAIM}`);
				}
				const triggers = this.store.readPendingReasonTriggers(input.actor.challengeId, now, limit);
				this.store.markReasonTriggersProcessing(
					input.actor.challengeId,
					triggers.map((trigger) => trigger.id),
					lease.generation,
					now,
				);
				return triggers.map((trigger) => ({
					...trigger,
					status: "processing" as const,
					leaseGeneration: lease.generation,
					updatedAt: now,
				}));
			},
			input,
		);
	}

	completeReasonTriggers(
		input: CommandBase & {
			ownerId: string;
			generation: number;
			token: string;
			triggerIds: string[];
		},
	): { completed: number } {
		this.requireReasoner();
		this.requireHost(input.actor, "Reason Trigger completion");
		const now = this.now();
		return this.idempotent(
			"completeReasonTriggers",
			{ ...input, createdAt: now },
			() => {
				const lease = this.requireReasonLease(input, now);
				const ids = unique(input.triggerIds);
				this.requireReasonTriggerBatch(ids);
				const triggers = this.store.readReasonTriggersByIds(input.actor.challengeId, ids);
				if (
					triggers.length !== ids.length ||
					triggers.some(
						(trigger) => trigger.status !== "processing" || trigger.leaseGeneration !== lease.generation,
					)
				) {
					throw new GraphServiceError("conflict", "Reason Trigger generation or status conflict");
				}
				const completed = this.store.completeReasonTriggerRows(input.actor.challengeId, ids, lease.generation, now);
				if (completed !== ids.length)
					throw new GraphServiceError("conflict", "Reason Trigger generation or status conflict");
				return { completed };
			},
			input,
		);
	}

	failReasonTriggers(
		input: CommandBase & {
			ownerId: string;
			generation: number;
			token: string;
			triggerIds: string[];
			error: string;
		},
	): { retried: number; deadLettered: number } {
		this.requireReasoner();
		this.requireHost(input.actor, "Reason Trigger failure");
		const now = this.now();
		return this.idempotent(
			"failReasonTriggers",
			{ ...input, createdAt: now },
			() => {
				const lease = this.requireReasonLease(input, now);
				const ids = unique(input.triggerIds);
				this.requireReasonTriggerBatch(ids);
				let retried = 0;
				let deadLettered = 0;
				const triggers = this.store.readReasonTriggersByIds(input.actor.challengeId, ids);
				if (
					triggers.length !== ids.length ||
					triggers.some(
						(trigger) => trigger.status !== "processing" || trigger.leaseGeneration !== lease.generation,
					)
				) {
					throw new GraphServiceError("conflict", "Reason Trigger generation or status conflict");
				}
				const current = new Map(triggers.map((trigger) => [trigger.id, trigger]));
				for (const id of ids) {
					const trigger = current.get(id)!;
					const delayMs = Math.min(60_000, 1_000 * 2 ** trigger.attemptCount);
					const result = this.store.failReasonTriggerRows({
						challengeId: input.actor.challengeId,
						ids: [id],
						generation: lease.generation,
						notBefore: new Date(Date.parse(now) + delayMs).toISOString(),
						lastError: this.sanitizeReasonError(input.error),
						maxAttempts: this.maxReasonAttempts,
						updatedAt: now,
					});
					retried += result.retried;
					deadLettered += result.deadLettered;
				}
				return { retried, deadLettered };
			},
			input,
		);
	}

	ensureReasonTriggerForChallenge(challengeId: string, recoverStalled = false): ReasonTrigger | undefined {
		this.requireReasoner();
		const now = this.now();
		return this.store.executeServiceTransaction(() => {
			const graph = this.store.readServiceGraph(challengeId);
			if (graph.goalState?.completed) return;
			if (
				!recoverStalled &&
				graph.intents.some((intent) => ["open", "claimed", "running", "blocked"].includes(intent.status))
			)
				return;
			const existing = this.store.readActionableReasonTrigger(challengeId);
			if (existing) return existing;
			this.store.ensureServiceChallenge(challengeId);
			const reason: ReasonTriggerReason = this.store.hasReasonHistory(challengeId)
				? "no_active_intents"
				: "initial_reason";
			const sequence = this.store.appendServiceEvent({
				challengeId,
				type: "reason_trigger_ensured",
				entityId: challengeId,
				actorId: "host",
				idempotencyKey: `reason-trigger:${reason}:${challengeId}${recoverStalled ? `:recovery:${this.store.getLatestEventSequence(challengeId)}` : ""}`,
				payload: { reason },
				createdAt: now,
			});
			return this.trigger(reason, challengeId, challengeId, sequence, { reason }, now);
		});
	}

	readReasonTriggers(challengeId: string, limit = 100): ReasonTrigger[] {
		this.requireReasoner();
		if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 256) {
			throw new GraphServiceError("validation", "limit must be between 1 and 256");
		}
		return this.store.readReasonTriggers(challengeId, limit);
	}

	listReasonWorkChallenges(limit = 32): string[] {
		this.requireReasoner();
		if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 32) {
			throw new GraphServiceError("validation", "limit must be between 1 and 32");
		}
		return this.store.readPendingReasonChallengeIds(this.now(), limit);
	}

	getReasonContext(input: {
		actor: GraphActor;
		ownerId: string;
		generation: number;
		token: string;
		triggerIds: string[];
	}): ReasonContextEnvelope {
		this.requireReasoner();
		this.requireHost(input.actor, "Reason Context read");
		const lease = this.requireReasonLease(input, this.now());
		const triggerIds = unique(input.triggerIds);
		this.requireReasonTriggerBatch(triggerIds);
		const triggers = this.store.readReasonTriggersByIds(input.actor.challengeId, triggerIds);
		if (
			triggers.length !== triggerIds.length ||
			triggers.some((trigger) => trigger.status !== "processing" || trigger.leaseGeneration !== lease.generation)
		) {
			throw new GraphServiceError("conflict", "Reason Trigger generation or status conflict");
		}
		const graph = this.store.readServiceGraph(input.actor.challengeId);
		if (graph.goalState?.completed) throw new GraphServiceError("conflict", "challenge is completed");
		return buildReasonContext(graph, triggers, this.store.getLatestEventSequence(input.actor.challengeId));
	}

	validateReasonProposalDraft(challengeId: string, proposal: ParsedReasonProposal): string[] {
		this.requireReasoner();
		const graph = this.store.readServiceGraph(challengeId);
		if (graph.goalState?.completed) return ["challenge is completed"];
		return validateReasonProposalDomain(proposal, graph);
	}

	createReasonProposal(input: PersistReasonProposalInput): ReasonProposal {
		return this.persistReasonProposal("proposed", input);
	}

	rejectReasonProposal(input: PersistReasonProposalInput & { validationErrors: string[] }): ReasonProposal {
		return this.persistReasonProposal("rejected", input);
	}

	readReasonProposal(challengeId: string, proposalId: string): ReasonProposal | undefined {
		this.requireReasoner();
		return this.store.readReasonProposal(challengeId, requireText(proposalId, "proposalId"));
	}

	listReasonProposals(challengeId: string, limit = 50): ReasonProposal[] {
		this.requireReasoner();
		if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
			throw new GraphServiceError("validation", "limit must be between 1 and 100");
		}
		return this.store.listReasonProposals(challengeId, limit);
	}

	applyReasonProposal(input: ApplyReasonProposalInput): ReasonProposalApplyResult {
		this.requireReasoner();
		this.requireHost(input.actor, "Reason Proposal apply");
		const createdAt = requireTimestamp(input.createdAt);
		const proposalId = requireText(input.proposalId, "proposalId");
		return this.idempotent("applyReasonProposal", input, () => {
			const existingApplication = this.store.readReasonProposalApplication(input.actor.challengeId, proposalId);
			if (existingApplication) return existingApplication;
			const proposal = this.store.readReasonProposal(input.actor.challengeId, proposalId);
			if (!proposal) throw new GraphServiceError("not_found", `reason proposal ${proposalId} was not found`);
			if (proposal.status === "rejected")
				throw new GraphServiceError("conflict", "rejected Reason Proposal cannot be applied");
			if (proposal.status === "applied") {
				const application = this.store.readReasonProposalApplication(input.actor.challengeId, proposalId);
				if (!application)
					throw new GraphServiceError("internal", "applied Proposal is missing its application record");
				return application;
			}

			const graph = this.store.readServiceGraph(input.actor.challengeId);
			const staleReasons = this.validateReasonProposalApply(proposal, graph);
			if (staleReasons.length > 0) {
				return this.persistReasonProposalApplyResult({
					proposal,
					input,
					status: "rejected_stale",
					createdAt,
					createdIntentIds: [],
					skippedIntents: [],
					supersededIntentIds: [],
					skippedSupersedes: [],
					staleReasons,
					createdIntentClientIds: new Map(),
					supersedeReplacementIntentIds: new Map(),
				});
			}

			const activeIntentFingerprints = new Map<string, string>();
			const completedIntentFingerprints = new Map<string, string>();
			for (const intent of graph.intents) {
				if (ACTIVE_INTENT_STATUSES.has(intent.status))
					activeIntentFingerprints.set(existingIntentFingerprint(intent), intent.id);
				else if (intent.status === "concluded" && intent.outcome === "success")
					completedIntentFingerprints.set(existingIntentFingerprint(intent), intent.id);
			}
			const skippedIntents: ReasonProposalSkippedIntent[] = [];
			const plannedIntents: Array<{ clientId: string; intent: GraphIntent }> = [];
			const createdByClientId = new Map<string, string>();
			const createdIntentClientIds = new Map<string, string>();

			for (const proposed of proposal.proposedIntents) {
				const fingerprint = reasonIntentFingerprint({
					challengeId: proposal.challengeId,
					objective: proposed.objective,
					fromFactIds: proposed.fromFactIds,
					sourceHintIds: proposed.sourceHintIds,
					capabilityTags: proposed.capabilityTags,
					successCriteria: proposed.successCriteria,
				});
				const duplicateIntentId = activeIntentFingerprints.get(fingerprint);
				if (duplicateIntentId) {
					skippedIntents.push({
						clientId: proposed.clientId,
						reason: "duplicate_active_intent",
						duplicateIntentId,
					});
					continue;
				}
				const completedIntentId = completedIntentFingerprints.get(fingerprint);
				if (completedIntentId) {
					skippedIntents.push({
						clientId: proposed.clientId,
						reason: "duplicate_completed_intent",
						duplicateIntentId: completedIntentId,
					});
					continue;
				}
				const intentId = generatedId(
					"intent",
					proposal.challengeId,
					"applyReasonProposal",
					`${proposal.id}:${proposed.clientId}`,
				);
				const intent: GraphIntent = {
					id: intentId,
					challengeId: proposal.challengeId,
					fromFactIds: unique(proposed.fromFactIds),
					sourceHintIds: unique(proposed.sourceHintIds),
					objective: proposed.objective,
					scope: proposed.successCriteria.join("\n"),
					capabilityTags: unique(proposed.capabilityTags),
					priority: proposed.priority,
					status: "open",
					resultFactIds: [],
					attemptCount: 0,
					version: 1,
					createdBy: input.actor.id,
					sourceIdeaIds: [],
					fingerprint: digest(["reason-apply", proposal.id, proposed.clientId, fingerprint]),
					createdAt,
					updatedAt: createdAt,
				};
				plannedIntents.push({ clientId: proposed.clientId, intent });
				createdByClientId.set(proposed.clientId, intent.id);
				createdIntentClientIds.set(intent.id, proposed.clientId);
				activeIntentFingerprints.set(fingerprint, intent.id);
			}

			const supersedePlans = this.buildSupersedePlans(proposal, createdByClientId, skippedIntents);
			if (supersedePlans.staleReasons.length > 0) {
				return this.persistReasonProposalApplyResult({
					proposal,
					input,
					status: "rejected_stale",
					createdAt,
					createdIntentIds: [],
					skippedIntents,
					supersededIntentIds: [],
					skippedSupersedes: [],
					staleReasons: supersedePlans.staleReasons,
					createdIntentClientIds: new Map(),
					supersedeReplacementIntentIds: new Map(),
				});
			}
			for (const planned of plannedIntents) {
				this.store.insertServiceIntent(planned.intent);
				this.store.appendServiceEvent({
					challengeId: planned.intent.challengeId,
					type: "intent_created_from_proposal",
					entityId: planned.intent.id,
					actorId: input.actor.id,
					idempotencyKey: `service:intent_created_from_proposal:${planned.intent.challengeId}:${proposal.id}:${planned.clientId}`,
					payload: { proposalId: proposal.id, clientId: planned.clientId },
					createdAt,
				});
			}
			const createdIntentIds = plannedIntents.map((planned) => planned.intent.id);
			const supersededIntentIds: string[] = [];
			const skippedSupersedes: ReasonProposalSkippedSupersede[] = [];
			const supersedeReplacementIntentIds = new Map<string, string>();
			for (const plan of supersedePlans.plans) {
				const target = this.store
					.readServiceGraph(input.actor.challengeId)
					.intents.find((intent) => intent.id === plan.intentId);
				if (!target) throw new GraphServiceError("not_found", `intent ${plan.intentId} was not found in challenge`);
				if (!SUPERSEDABLE_INTENT_STATUSES.has(target.status)) {
					throw new GraphServiceError(
						"conflict",
						`intent ${plan.intentId} cannot be superseded from status ${target.status}`,
					);
				}
				this.store.updateIntentLeaseState({
					challengeId: target.challengeId,
					intentId: target.id,
					expectedVersion: target.version,
					status: "superseded",
					updatedAt: createdAt,
				});
				this.store.appendServiceEvent({
					challengeId: target.challengeId,
					type: "intent_superseded",
					entityId: target.id,
					actorId: input.actor.id,
					idempotencyKey: `service:intent_superseded:${target.challengeId}:${proposal.id}:${target.id}`,
					payload: { proposalId: proposal.id, replacementIntentId: plan.replacementIntentId },
					createdAt,
				});
				supersededIntentIds.push(target.id);
				if (plan.replacementIntentId) supersedeReplacementIntentIds.set(target.id, plan.replacementIntentId);
			}

			const status = createdIntentIds.length === 0 && supersededIntentIds.length === 0 ? "no_op" : "applied";
			return this.persistReasonProposalApplyResult({
				proposal,
				input,
				status,
				createdAt,
				createdIntentIds,
				skippedIntents,
				supersededIntentIds,
				skippedSupersedes,
				staleReasons: [],
				createdIntentClientIds,
				supersedeReplacementIntentIds,
			});
		});
	}

	readReasonProposalApplication(challengeId: string, proposalId: string): ReasonProposalApplyResult | undefined {
		this.requireReasoner();
		return this.store.readReasonProposalApplication(challengeId, requireText(proposalId, "proposalId"));
	}

	private async registerArtifactLocked(input: RegisterArtifactInput): Promise<GraphArtifact> {
		const repeated = this.readIdempotentResult<GraphArtifact>("registerArtifact", input);
		if (repeated) return repeated;
		const createdAt = requireTimestamp(input.createdAt);
		const mimeType = requireText(input.mimeType, "mimeType");
		if (!/^[a-f0-9]{64}$/.test(input.sha256)) {
			throw new GraphServiceError("validation", "artifact sha256 must be 64 lowercase hexadecimal characters");
		}
		if (!Number.isSafeInteger(input.size) || input.size < 0) {
			throw new GraphServiceError("validation", "artifact size must be a non-negative safe integer");
		}
		if (isAbsolute(input.relativePath)) throw new GraphServiceError("validation", "artifact path must be relative");
		const sourceRelativePath = input.relativePath.trim();
		if (!sourceRelativePath) throw new GraphServiceError("validation", "relativePath is required");
		const workspaceRoot = resolve(requireText(input.solverWorkspacePath, "solverWorkspacePath"));
		let workspaceRealPath: string;
		try {
			workspaceRealPath = await realpath(workspaceRoot);
		} catch {
			throw new GraphServiceError("not_found", "solver workspace was not found");
		}
		const sourcePath = resolve(workspaceRoot, sourceRelativePath);
		if (!isPathInside(workspaceRoot, sourcePath)) {
			throw new GraphServiceError("forbidden", "artifact source escapes the solver workspace");
		}
		let sourceStats: Stats;
		try {
			await assertPathHasNoLinks(workspaceRoot, relative(workspaceRoot, sourcePath));
			sourceStats = await lstat(sourcePath);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				throw new GraphServiceError("not_found", "artifact source file was not found");
			}
			throw error;
		}
		if (sourceStats.isSymbolicLink() || !sourceStats.isFile()) {
			throw new GraphServiceError("validation", "artifact source must be a regular file");
		}
		const sourceRealPath = await realpath(sourcePath);
		if (!isPathInside(workspaceRealPath, sourceRealPath)) {
			throw new GraphServiceError("forbidden", "artifact source resolves outside the solver workspace");
		}

		const challengeRoot = resolve(this.artifactRoot, input.actor.challengeId, "artifacts");
		const challengePath = relative(this.artifactRoot, challengeRoot);
		if (challengePath.startsWith(`..${sep}`) || isAbsolute(challengePath)) {
			throw new GraphServiceError("forbidden", "challenge artifact root escapes the Host artifact root");
		}
		await mkdir(this.artifactRoot, { recursive: true });
		await assertPathHasNoLinks(this.artifactRoot, "");
		const challengeRelativePath = relative(this.artifactRoot, challengeRoot);
		await mkdirWithoutLinks(this.artifactRoot, challengeRelativePath, this.createArtifactDirectory);
		await assertPathHasNoLinks(this.artifactRoot, relative(this.artifactRoot, challengeRoot));
		const challengeRealPath = await realpath(challengeRoot);
		if (!isPathInside(await realpath(this.artifactRoot), challengeRealPath)) {
			throw new GraphServiceError("forbidden", "challenge artifact root resolves outside the Host artifact root");
		}
		const fullPath = resolve(challengeRoot, sourceRelativePath);
		const pathFromRoot = relative(challengeRoot, fullPath);
		if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
			throw new GraphServiceError("forbidden", "artifact path escapes the challenge artifact root");
		}
		await mkdirWithoutLinks(challengeRoot, relative(challengeRoot, dirname(fullPath)), this.createArtifactDirectory);
		await assertPathHasNoLinks(challengeRoot, relative(challengeRoot, dirname(fullPath)));
		await assertPathHasNoLinks(challengeRoot, pathFromRoot, true);

		const temporaryPath = resolve(dirname(fullPath), `.${randomUUID()}.artifact.tmp`);
		let published = false;
		let registered = false;
		let publishedIdentity: { dev: number; ino: number } | undefined;
		try {
			await this.copyArtifactFile(sourceRealPath, temporaryPath);
			const temporaryStats = await lstat(temporaryPath);
			if (temporaryStats.isSymbolicLink() || !temporaryStats.isFile()) {
				throw new GraphServiceError("forbidden", "managed artifact temporary file is not a regular file");
			}
			const temporaryRealPath = await realpath(temporaryPath);
			if (!isPathInside(challengeRealPath, temporaryRealPath)) {
				throw new GraphServiceError(
					"forbidden",
					"managed artifact temporary file resolves outside the Challenge artifact root",
				);
			}
			const temporaryBytes = await readFile(temporaryRealPath);
			const actualHash = createHash("sha256").update(new Uint8Array(temporaryBytes)).digest("hex");
			if (actualHash !== input.sha256) {
				throw new GraphServiceError("validation", "artifact sha256 does not match");
			}
			if (temporaryStats.size !== input.size) {
				throw new GraphServiceError("validation", "artifact size does not match");
			}
			const artifact: GraphArtifact = {
				id: generatedId("artifact", input.actor.challengeId, "registerArtifact", input.idempotencyKey),
				challengeId: input.actor.challengeId,
				solverId: input.actor.id,
				intentId: input.intentId,
				path: pathFromRoot.split(sep).join("/"),
				sha256: actualHash,
				mimeType,
				size: temporaryStats.size,
				createdAt,
			};

			await link(temporaryPath, fullPath);
			published = true;
			const targetStats = await lstat(fullPath);
			publishedIdentity = { dev: targetStats.dev, ino: targetStats.ino };
			if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
				throw new GraphServiceError("forbidden", "managed artifact target is not a regular file");
			}
			const targetRealPath = await realpath(fullPath);
			if (!isPathInside(challengeRealPath, targetRealPath)) {
				throw new GraphServiceError(
					"forbidden",
					"managed artifact target resolves outside the Challenge artifact root",
				);
			}
			const result = this.idempotent("registerArtifact", input, () => {
				this.store.insertArtifact(artifact);
				this.event(artifact.challengeId, "artifact_registered", artifact.id, input, artifact);
				return artifact;
			});
			registered = true;
			return result;
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
				throw new GraphServiceError("conflict", "managed artifact path already exists");
			}
			throw error;
		} finally {
			await unlink(temporaryPath).catch(() => {});
			if (published && !registered && publishedIdentity) {
				const currentStats = await lstat(fullPath).catch(() => undefined);
				if (currentStats?.dev === publishedIdentity.dev && currentStats.ino === publishedIdentity.ino) {
					await unlink(fullPath).catch(() => {});
				}
			}
		}
	}

	private persistReasonProposal(status: "proposed" | "rejected", input: PersistReasonProposalInput): ReasonProposal {
		this.requireReasoner();
		this.requireHost(input.actor, "Reason Proposal persistence");
		const createdAt = requireTimestamp(input.createdAt);
		const validationErrors = [...new Set(input.validationErrors ?? [])].sort();
		if (status === "proposed" && validationErrors.length > 0) {
			throw new GraphServiceError("validation", "proposed Reason Proposal cannot contain validation errors");
		}
		if (status === "rejected" && validationErrors.length === 0) {
			throw new GraphServiceError("validation", "rejected Reason Proposal requires validation errors");
		}
		return this.idempotent(status === "proposed" ? "createReasonProposal" : "rejectReasonProposal", input, () => {
			const lease = this.requireReasonLease(input, createdAt);
			const triggerIds = unique(input.sourceTriggerIds);
			this.requireReasonTriggerBatch(triggerIds);
			const triggers = this.store.readReasonTriggersByIds(input.actor.challengeId, triggerIds);
			if (
				triggers.length !== triggerIds.length ||
				triggers.some((trigger) => trigger.status !== "processing" || trigger.leaseGeneration !== lease.generation)
			) {
				throw new GraphServiceError("conflict", "Reason Trigger generation or status conflict");
			}
			const graph = this.store.readServiceGraph(input.actor.challengeId);
			if (graph.goalState?.completed) throw new GraphServiceError("conflict", "challenge is completed");
			const domainErrors = validateReasonProposalDomain(input, graph);
			if (status === "proposed" && domainErrors.length > 0) {
				throw new GraphServiceError("validation", domainErrors.join("; "));
			}
			if (status === "rejected" && validationErrors.join("\n") !== domainErrors.join("\n")) {
				throw new GraphServiceError(
					"validation",
					"rejected Proposal validation errors do not match Host validation",
				);
			}
			const baseEventSequence = requireSafeInteger(input.baseEventSequence, "baseEventSequence");
			const proposal: ReasonProposal = {
				id: generatedId("reason_proposal", input.actor.challengeId, status, input.idempotencyKey),
				challengeId: input.actor.challengeId,
				status,
				sourceTriggerIds: triggerIds,
				reasonLeaseGeneration: lease.generation,
				baseEventSequence,
				contextFingerprint: requireText(input.contextFingerprint, "contextFingerprint"),
				rationaleSummary: input.rationaleSummary,
				proposedIntents: input.proposedIntents,
				supersedeRecommendations: input.supersedeRecommendations,
				model: requireText(input.model, "model"),
				provider: requireText(input.provider, "provider"),
				promptVersion: requireText(input.promptVersion, "promptVersion"),
				createdAt,
				validationErrors,
			};
			this.store.insertReasonProposal(proposal);
			const completed = this.store.completeReasonTriggerRows(
				input.actor.challengeId,
				triggerIds,
				lease.generation,
				createdAt,
			);
			if (completed !== triggerIds.length) {
				throw new GraphServiceError("conflict", "Reason Trigger generation or status conflict");
			}
			this.store.appendServiceEvent({
				challengeId: input.actor.challengeId,
				type: status === "proposed" ? "reason_proposal_created" : "reason_proposal_rejected",
				entityId: proposal.id,
				actorId: input.actor.id,
				idempotencyKey: `service:reason-proposal:${status}:${input.actor.challengeId}:${input.idempotencyKey}`,
				payload: {
					status,
					sourceTriggerIds: triggerIds,
					proposedIntentCount: proposal.proposedIntents.length,
					supersedeRecommendationCount: proposal.supersedeRecommendations.length,
					validationErrorCount: proposal.validationErrors.length,
					baseEventSequence,
					contextFingerprint: proposal.contextFingerprint,
					promptVersion: proposal.promptVersion,
					model: proposal.model,
					provider: proposal.provider,
				},
				createdAt,
			});
			return proposal;
		});
	}

	private validateReasonProposalApply(
		proposal: ReasonProposal,
		graph: ReturnType<GraphStore["readServiceGraph"]>,
	): string[] {
		const errors: string[] = [];
		if (graph.goalState?.completed) errors.push("challenge is completed");
		const facts = new Map(graph.facts.map((fact) => [fact.id, fact]));
		const hints = new Map(graph.hints.map((hint) => [hint.id, hint]));
		const intents = new Map(graph.intents.map((intent) => [intent.id, intent]));
		for (const proposed of proposal.proposedIntents) {
			for (const factId of proposed.fromFactIds) {
				const fact = facts.get(factId);
				if (!fact) errors.push(`fact ${factId} was not found`);
				else if (fact.status !== "active") errors.push(`fact ${factId} is not active`);
				if (hints.has(factId)) errors.push(`fromFactIds cannot contain Hint ${factId}`);
			}
			for (const hintId of proposed.sourceHintIds) {
				if (!hints.has(hintId)) errors.push(`hint ${hintId} was not found`);
				if (facts.has(hintId)) errors.push(`sourceHintIds cannot contain Fact ${hintId}`);
			}
			for (const intentId of proposed.supersedesIntentIds) {
				const intent = intents.get(intentId);
				if (!intent) errors.push(`intent ${intentId} was not found`);
				else if (!SUPERSEDABLE_INTENT_STATUSES.has(intent.status))
					errors.push(`intent ${intentId} cannot be superseded from status ${intent.status}`);
			}
		}
		for (const recommendation of proposal.supersedeRecommendations) {
			const intent = intents.get(recommendation.intentId);
			if (!intent) errors.push(`intent ${recommendation.intentId} was not found`);
			else if (!SUPERSEDABLE_INTENT_STATUSES.has(intent.status)) {
				errors.push(`intent ${recommendation.intentId} cannot be superseded from status ${intent.status}`);
			}
			if (
				recommendation.replacementClientId &&
				!proposal.proposedIntents.some((item) => item.clientId === recommendation.replacementClientId)
			) {
				errors.push(`replacementClientId ${recommendation.replacementClientId} was not found in Proposal`);
			}
		}
		return [...new Set(errors)].sort();
	}

	private buildSupersedePlans(
		proposal: ReasonProposal,
		createdByClientId: Map<string, string>,
		skippedIntents: ReasonProposalSkippedIntent[],
	): { plans: Array<{ intentId: string; replacementIntentId?: string }>; staleReasons: string[] } {
		const plans = new Map<string, { intentId: string; replacementIntentId?: string }>();
		const staleReasons: string[] = [];
		const skippedClientIds = new Set(skippedIntents.map((item) => item.clientId));
		for (const proposed of proposal.proposedIntents) {
			for (const intentId of proposed.supersedesIntentIds) {
				if (skippedClientIds.has(proposed.clientId)) {
					staleReasons.push(`replacementClientId ${proposed.clientId} was skipped as duplicate`);
					continue;
				}
				plans.set(intentId, { intentId, replacementIntentId: createdByClientId.get(proposed.clientId) });
			}
		}
		for (const recommendation of proposal.supersedeRecommendations) {
			if (recommendation.replacementClientId && skippedClientIds.has(recommendation.replacementClientId)) {
				staleReasons.push(`replacementClientId ${recommendation.replacementClientId} was skipped as duplicate`);
				continue;
			}
			plans.set(recommendation.intentId, {
				intentId: recommendation.intentId,
				replacementIntentId: recommendation.replacementClientId
					? createdByClientId.get(recommendation.replacementClientId)
					: undefined,
			});
		}
		return {
			plans: [...plans.values()].sort((left, right) => left.intentId.localeCompare(right.intentId)),
			staleReasons,
		};
	}

	private persistReasonProposalApplyResult(input: {
		proposal: ReasonProposal;
		input: ApplyReasonProposalInput;
		status: ReasonProposalApplyResult["status"];
		createdAt: string;
		createdIntentIds: string[];
		skippedIntents: ReasonProposalSkippedIntent[];
		supersededIntentIds: string[];
		skippedSupersedes: ReasonProposalSkippedSupersede[];
		staleReasons: string[];
		createdIntentClientIds: Map<string, string>;
		supersedeReplacementIntentIds: Map<string, string>;
	}): ReasonProposalApplyResult {
		const resultWithoutSequence = {
			proposalId: input.proposal.id,
			challengeId: input.proposal.challengeId,
			status: input.status,
			createdIntentIds: [...input.createdIntentIds].sort(),
			skippedIntents: [...input.skippedIntents].sort((left, right) => left.clientId.localeCompare(right.clientId)),
			supersededIntentIds: [...input.supersededIntentIds].sort(),
			skippedSupersedes: [...input.skippedSupersedes].sort((left, right) =>
				left.intentId.localeCompare(right.intentId),
			),
			staleReasons: [...new Set(input.staleReasons)].sort(),
			appliedAt: input.createdAt,
		};
		const sequence = this.store.appendServiceEvent({
			challengeId: input.proposal.challengeId,
			type: input.status === "rejected_stale" ? "reason_proposal_apply_rejected" : "reason_proposal_applied",
			entityId: input.proposal.id,
			actorId: input.input.actor.id,
			idempotencyKey: `service:reason-proposal-apply:${input.proposal.challengeId}:${input.input.idempotencyKey}`,
			payload: {
				proposalId: input.proposal.id,
				status: input.status,
				createdIntentCount: input.createdIntentIds.length,
				skippedIntentCount: input.skippedIntents.length,
				supersededIntentCount: input.supersededIntentIds.length,
				skippedSupersedeCount: input.skippedSupersedes.length,
				staleReasons: resultWithoutSequence.staleReasons,
				baseEventSequence: input.proposal.baseEventSequence,
			},
			createdAt: input.createdAt,
		});
		const result: ReasonProposalApplyResult = { ...resultWithoutSequence, eventSequence: sequence };
		this.store.insertReasonProposalApplication(
			result,
			input.input.idempotencyKey,
			input.input.actor.id,
			input.proposal.baseEventSequence,
			input.createdIntentClientIds,
			input.supersedeReplacementIntentIds,
		);
		if (input.status !== "rejected_stale")
			this.store.markReasonProposalApplied(input.proposal.challengeId, input.proposal.id);
		return result;
	}

	getGraphDelta(challengeId: string, afterSequence = 0): GraphDelta {
		if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
			throw new GraphServiceError("validation", "afterSequence must be a non-negative integer");
		}
		const page = this.store.readEventsAfter(challengeId, afterSequence, GRAPH_DELTA_PAGE_SIZE + 1);
		const hasMore = page.length > GRAPH_DELTA_PAGE_SIZE;
		const events = page.slice(0, GRAPH_DELTA_PAGE_SIZE);
		return {
			challengeId,
			afterSequence,
			latestSequence: this.store.getLatestEventSequence(challengeId),
			nextSequence: events.at(-1)?.sequence ?? afterSequence,
			hasMore,
			events,
		};
	}

	getFocusedContext(challengeId: string, afterSequence = 0, limits?: FocusedContextLimits): FocusedGraphContext {
		requireSafeInteger(afterSequence, "afterSequence");
		const boundedLimits: FocusedContextLimits = {
			maxFacts: boundedLimit(limits?.maxFacts, "maxFacts", FOCUSED_CONTEXT_MAX_LIMITS.maxFacts),
			maxHints: boundedLimit(limits?.maxHints, "maxHints", FOCUSED_CONTEXT_MAX_LIMITS.maxHints),
			maxIntents: boundedLimit(limits?.maxIntents, "maxIntents", FOCUSED_CONTEXT_MAX_LIMITS.maxIntents),
			maxEvents: boundedLimit(limits?.maxEvents, "maxEvents", FOCUSED_CONTEXT_MAX_LIMITS.maxEvents),
			maxTokens: boundedLimit(limits?.maxTokens, "maxTokens", FOCUSED_CONTEXT_MAX_LIMITS.maxTokens),
			maxCharacters: boundedLimit(limits?.maxCharacters, "maxCharacters", FOCUSED_CONTEXT_MAX_LIMITS.maxCharacters),
		};
		return buildFocusedContext(
			this.store.readServiceGraph(challengeId),
			this.store.readEventsAfter(challengeId, afterSequence, boundedLimits.maxEvents),
			boundedLimits,
		);
	}

	getIntentFocusedContext(
		challengeId: string,
		intentId: string,
		afterSequence = 0,
		limits?: FocusedContextLimits,
	): FocusedGraphContext {
		requireSafeInteger(afterSequence, "afterSequence");
		const boundedLimits: FocusedContextLimits = {
			maxFacts: boundedLimit(limits?.maxFacts, "maxFacts", FOCUSED_CONTEXT_MAX_LIMITS.maxFacts),
			maxHints: boundedLimit(limits?.maxHints, "maxHints", FOCUSED_CONTEXT_MAX_LIMITS.maxHints),
			maxIntents: boundedLimit(limits?.maxIntents, "maxIntents", FOCUSED_CONTEXT_MAX_LIMITS.maxIntents),
			maxEvents: boundedLimit(limits?.maxEvents, "maxEvents", FOCUSED_CONTEXT_MAX_LIMITS.maxEvents),
			maxTokens: boundedLimit(limits?.maxTokens, "maxTokens", FOCUSED_CONTEXT_MAX_LIMITS.maxTokens),
			maxCharacters: boundedLimit(limits?.maxCharacters, "maxCharacters", FOCUSED_CONTEXT_MAX_LIMITS.maxCharacters),
		};
		return buildIntentFocusedContext(
			this.store.readServiceGraph(challengeId),
			intentId,
			this.store.readEventsAfter(challengeId, afterSequence, boundedLimits.maxEvents),
			boundedLimits,
		);
	}

	private completeIntentTransaction(
		operation: "checkpointIntent" | "concludeIntent",
		input: LeaseCommandInput & ResultSubmissionInput & { outcome?: IntentOutcome },
		conclude: boolean,
	): IntentCheckpointResult | IntentConcludeResult {
		const now = this.now();
		return this.idempotent(
			operation,
			{ ...input, createdAt: now },
			() => {
				const { intent, claim } = this.requireLease(input, now);
				if (intent.status !== "running") throw new GraphServiceError("conflict", "intent must be running");
				for (const artifactId of unique(input.artifactIds)) {
					const artifact = this.store.readArtifact(intent.challengeId, artifactId);
					if (!artifact)
						throw new GraphServiceError("not_found", `artifact ${artifactId} was not found in challenge`);
					if (artifact.intentId && artifact.intentId !== intent.id) {
						throw new GraphServiceError("conflict", `artifact ${artifactId} belongs to another intent`);
					}
				}

				const resultFactIds = new Set(unique(input.factIds));
				for (const factId of resultFactIds) {
					const fact = this.store.readServiceGraph(intent.challengeId).facts.find((item) => item.id === factId);
					if (!fact) throw new GraphServiceError("not_found", `fact ${factId} was not found in challenge`);
				}
				for (const submitted of input.facts ?? []) {
					if (!FACT_KINDS.has(submitted.kind))
						throw new GraphServiceError("validation", "unsupported result Fact kind");
					const statement = requireText(submitted.statement, "fact statement");
					const fingerprint = digest([
						intent.challengeId,
						submitted.kind,
						statement.trim().replace(/\s+/g, " ").toLowerCase(),
					]);
					let fact = this.store.readFactByFingerprint(intent.challengeId, fingerprint);
					if (!fact) {
						const candidateId = `fact_candidate_${digest([intent.id, fingerprint]).slice(0, 24)}`;
						this.store.insertFactCandidate({
							id: candidateId,
							challengeId: intent.challengeId,
							kind: submitted.kind,
							statement,
							confidence: 1,
							evidenceRefs: unique(submitted.evidenceRefs),
							sourceEventIds: [],
							sourceActorId: claim.solverId,
							sourceRole: "solver",
							status: "proposed",
							createdAt: now,
							updatedAt: now,
						});
						fact = {
							id: `fact_${fingerprint.slice(0, 24)}`,
							challengeId: intent.challengeId,
							kind: submitted.kind,
							statement,
							evidenceRefs: unique(submitted.evidenceRefs),
							sourceSolverId: claim.solverId,
							sourceMemoryIds: [],
							producedByIntentId: intent.id,
							fingerprint,
							status: "active",
							observedAt: now,
							createdAt: now,
						};
						this.store.insertServiceFact(fact);
						this.store.confirmFactCandidate(intent.challengeId, candidateId, fact.id, now);
					} else {
						for (const evidenceRef of unique(submitted.evidenceRefs)) {
							this.store.appendServiceFactEvidence(intent.challengeId, fact.id, evidenceRef);
						}
					}
					resultFactIds.add(fact.id);
				}
				for (const factId of [...resultFactIds].sort())
					this.store.appendIntentResult(intent.challengeId, intent.id, factId);

				let version: number;
				if (conclude) {
					this.store.updateActiveClaim(claim.id, { status: "concluded", updatedAt: now });
					version = this.store.updateIntentLeaseState({
						challengeId: intent.challengeId,
						intentId: intent.id,
						expectedVersion: intent.version,
						status: "concluded",
						outcome: input.outcome,
						updatedAt: now,
					});
				} else {
					version = this.store.updateIntentLeaseState({
						challengeId: intent.challengeId,
						intentId: intent.id,
						expectedVersion: intent.version,
						status: "running",
						ownerSolverId: claim.solverId,
						leaseUntil: claim.leaseUntil,
						updatedAt: now,
					});
				}
				const result = {
					intentId: intent.id,
					version,
					resultFactIds: [...resultFactIds].sort(),
					...(conclude ? { outcome: input.outcome as IntentOutcome } : {}),
				};
				const sequence = this.event(
					intent.challengeId,
					conclude ? "intent_concluded" : "intent_checkpointed",
					intent.id,
					{ ...input, createdAt: now },
					{
						solverId: claim.solverId,
						generation: claim.generation,
						version,
						resultFactIds: result.resultFactIds,
						...(conclude ? { outcome: input.outcome } : {}),
					},
				);
				if (conclude) {
					const hasActive = this.store
						.readServiceGraph(intent.challengeId)
						.intents.some((item) => ["open", "claimed", "running", "blocked"].includes(item.status));
					this.trigger(
						hasActive ? "intent_concluded" : "no_active_intents",
						intent.challengeId,
						intent.id,
						sequence,
						result,
						now,
					);
				} else if (result.resultFactIds.some((id) => !intent.resultFactIds.includes(id))) {
					// Fresh live results wake planning without concluding or cancelling their owner.
					this.trigger("fact_confirmed", intent.challengeId, intent.id, sequence, result, now);
				}
				return result;
			},
			input,
		);
	}

	private leaseTransition(
		operation: string,
		input: LeaseCommandInput,
		requiredStatus: GraphIntent["status"],
		write: (intent: GraphIntent, claim: IntentClaim, now: string) => IntentLease,
	): IntentLease {
		const now = this.now();
		return this.idempotent(
			operation,
			{ ...input, createdAt: now },
			() => {
				const { intent, claim } = this.requireLease(input, now);
				if (intent.status !== requiredStatus)
					throw new GraphServiceError("conflict", `intent must be ${requiredStatus}`);
				const result = write(intent, claim, now);
				this.event(
					intent.challengeId,
					"intent_acknowledged",
					intent.id,
					{ ...input, createdAt: now },
					{
						solverId: claim.solverId,
						generation: claim.generation,
						version: (result as { version?: unknown }).version,
					},
				);
				return result;
			},
			input,
			this.leaseResultCodec(input.token),
		);
	}

	private requireLease(input: LeaseCommandInput, now: string): { intent: GraphIntent; claim: IntentClaim } {
		if (input.actor.role !== "solver")
			throw new GraphServiceError("forbidden", "Lease command requires a solver actor");
		if (input.actor.id !== input.actor.id.trim()) throw new GraphServiceError("validation", "solverId is invalid");
		const intent = this.requireActiveChallengeIntent(input.actor.challengeId, input.intentId);
		if (intent.version !== requireSafeInteger(input.expectedVersion, "expectedVersion")) {
			throw new GraphServiceError("conflict", "intent version conflict");
		}
		const claim = this.store.readActiveClaimByIntent(intent.challengeId, intent.id);
		if (!claim) throw new GraphServiceError("forbidden", "active Lease was not found");
		if (claim.solverId !== input.actor.id)
			throw new GraphServiceError("forbidden", "Lease owner does not match solver");
		if (claim.generation !== requireSafeInteger(input.generation, "generation")) {
			throw new GraphServiceError("conflict", "Lease generation is stale");
		}
		if (claim.tokenHash !== digest(requireText(input.token, "token"))) {
			throw new GraphServiceError("forbidden", "Lease credential is invalid");
		}
		if (Date.parse(claim.leaseUntil) <= Date.parse(now)) {
			throw new GraphServiceError("conflict", "Lease has expired");
		}
		return { intent, claim };
	}

	private requireActiveChallengeIntent(challengeId: string, intentId: string): GraphIntent {
		const graph = this.store.readServiceGraph(challengeId);
		if (graph.goalState?.completed) throw new GraphServiceError("conflict", "challenge is completed");
		const intent = graph.intents.find((item) => item.id === intentId);
		if (!intent) throw new GraphServiceError("not_found", `intent ${intentId} was not found in challenge`);
		return intent;
	}

	private publicLease(claim: IntentClaim, token: string): Omit<IntentLease, "version"> {
		return {
			challengeId: claim.challengeId,
			intentId: claim.intentId,
			solverId: claim.solverId,
			token,
			generation: claim.generation,
			leaseUntil: claim.leaseUntil,
		};
	}

	private requireLeaseDuration(value: number): number {
		if (!Number.isSafeInteger(value) || value < MIN_LEASE_DURATION_MS || value > MAX_LEASE_DURATION_MS) {
			throw new GraphServiceError(
				"validation",
				`leaseDurationMs must be an integer between ${MIN_LEASE_DURATION_MS} and ${MAX_LEASE_DURATION_MS}`,
			);
		}
		return value;
	}

	private now(): string {
		const date = this.clock.now();
		if (!(date instanceof Date) || !Number.isFinite(date.getTime()))
			throw new GraphServiceError("internal", "Clock returned invalid time");
		return date.toISOString();
	}

	private idempotent<T>(
		operation: string,
		input: CommandBase,
		write: () => T,
		payload: unknown = input,
		codec?: { persist(result: T): unknown; restore(result: unknown): T },
	): T {
		requireText(input.idempotencyKey, "idempotencyKey");
		requireTimestamp(input.createdAt);
		const payloadHash = digest(payload);
		return this.store.executeServiceTransaction(() => {
			this.store.ensureServiceChallenge(input.actor.challengeId);
			const existing = this.store.readIdempotencyRecord(input.actor.challengeId, operation, input.idempotencyKey);
			if (existing) {
				if (existing.payloadHash !== payloadHash) {
					throw new GraphServiceError("conflict", `idempotency key conflict for ${operation}`);
				}
				return codec ? codec.restore(existing.result) : (existing.result as T);
			}
			const result = write();
			this.store.writeIdempotencyRecord({
				challengeId: input.actor.challengeId,
				operation,
				idempotencyKey: input.idempotencyKey,
				payloadHash,
				result: codec ? codec.persist(result) : result,
				createdAt: input.createdAt,
			});
			return result;
		});
	}

	private leaseResultCodec(token: string): {
		persist(result: IntentLease): unknown;
		restore(result: unknown): IntentLease;
	} {
		return {
			persist: ({ token: _token, ...result }) => result,
			restore: (result) => ({ ...(result as Omit<IntentLease, "token">), token }),
		};
	}

	private deriveLeaseToken(
		challengeId: string,
		intentId: string,
		solverId: string,
		generation: number,
		idempotencyKey: string,
	): string {
		return createHmac("sha256", this.leaseTokenSecret)
			.update(JSON.stringify([challengeId, intentId, solverId, generation, idempotencyKey]))
			.digest("base64url");
	}

	private deriveReasonLeaseToken(
		challengeId: string,
		ownerId: string,
		generation: number,
		idempotencyKey: string,
	): string {
		return createHmac("sha256", this.leaseTokenSecret)
			.update(JSON.stringify(["reason", challengeId, ownerId, generation, idempotencyKey]))
			.digest("base64url");
	}

	private readIdempotentResult<T>(operation: string, input: CommandBase): T | undefined {
		requireText(input.idempotencyKey, "idempotencyKey");
		requireTimestamp(input.createdAt);
		const existing = this.store.readIdempotencyRecord(input.actor.challengeId, operation, input.idempotencyKey);
		if (!existing) return;
		if (existing.payloadHash !== digest(input)) {
			throw new GraphServiceError("conflict", `idempotency key conflict for ${operation}`);
		}
		return existing.result as T;
	}

	private event(challengeId: string, type: string, entityId: string, input: CommandBase, payload: unknown): number {
		return this.store.appendServiceEvent({
			challengeId,
			type,
			entityId,
			actorId: input.actor.id,
			idempotencyKey: `service:${type}:${challengeId}:${input.idempotencyKey}`,
			payload,
			createdAt: input.createdAt,
		});
	}

	private trigger(
		reason: ReasonTriggerReason,
		challengeId: string,
		sourceEntityId: string,
		sourceEventSequence: number,
		payload: unknown,
		createdAt: string,
	): ReasonTrigger | undefined {
		if (!this.reasonerEnabled) return;
		if (this.store.readServiceGraph(challengeId).goalState?.completed) return;
		const payloadFingerprint = digest(payload);
		const trigger: ReasonTrigger = {
			id: `reason_trigger_${digest([challengeId, reason, sourceEventSequence, sourceEntityId, payloadFingerprint]).slice(0, 24)}`,
			challengeId,
			reason,
			sourceEventSequence,
			sourceEntityId,
			payloadFingerprint,
			status: "pending",
			attemptCount: 0,
			notBefore: createdAt,
			createdAt,
			updatedAt: createdAt,
		};
		if (this.store.insertReasonTrigger(trigger)) return trigger;
		const existing = this.store.readReasonTrigger(challengeId, trigger.id);
		return existing && ["pending", "processing"].includes(existing.status) ? existing : undefined;
	}

	private requireReasoner(): void {
		if (!this.reasonerEnabled) throw new GraphServiceError("forbidden", "Graph Reasoner control plane is disabled");
	}

	private requireReasonLease(
		input: { actor: GraphActor; ownerId: string; generation: number; token: string },
		now: string,
	): ReasonLeaseRecord {
		const lease = this.store.readActiveReasonLease(input.actor.challengeId);
		if (!lease) throw new GraphServiceError("forbidden", "active Reason Lease was not found");
		if (lease.ownerId !== requireText(input.ownerId, "ownerId"))
			throw new GraphServiceError("forbidden", "Reason Lease owner mismatch");
		if (lease.generation !== requireSafeInteger(input.generation, "generation")) {
			throw new GraphServiceError("conflict", "Reason Lease generation is stale");
		}
		if (lease.tokenHash !== digest(requireText(input.token, "token"))) {
			throw new GraphServiceError("forbidden", "Reason Lease credential is invalid");
		}
		if (Date.parse(lease.leaseUntil) <= Date.parse(now))
			throw new GraphServiceError("conflict", "Reason Lease has expired");
		return lease;
	}

	private requireReasonLeaseDuration(value: number): number {
		if (
			!Number.isSafeInteger(value) ||
			value < MIN_REASON_LEASE_DURATION_MS ||
			value > MAX_REASON_LEASE_DURATION_MS
		) {
			throw new GraphServiceError(
				"validation",
				`leaseDurationMs must be an integer between ${MIN_REASON_LEASE_DURATION_MS} and ${MAX_REASON_LEASE_DURATION_MS}`,
			);
		}
		return value;
	}

	private sanitizeReasonError(error: string): string {
		return requireText(error, "error")
			.replace(/(?:token|cookie|api[-_ ]?key|authorization)\s*[:=]\s*\S+/gi, "credential:[redacted]")
			.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
			.slice(0, 240);
	}

	private requireReasonTriggerBatch(ids: string[]): void {
		if (ids.length === 0 || ids.length > MAX_REASON_TRIGGER_BATCH) {
			throw new GraphServiceError(
				"validation",
				`triggerIds must contain between 1 and ${MAX_REASON_TRIGGER_BATCH} unique IDs`,
			);
		}
		for (const id of ids) requireText(id, "triggerId");
	}

	private requireHost(actor: GraphActor, action = "Candidate confirmation"): void {
		if (actor.role !== "host") throw new GraphServiceError("forbidden", `${action} requires a host actor`);
	}

	private validateIntentReferences(
		candidate: Pick<IntentCandidate, "challengeId" | "fromFactIds" | "sourceHintIds">,
	): void {
		const snapshot = this.store.readServiceGraph(candidate.challengeId);
		const facts = new Set(snapshot.facts.map((fact) => fact.id));
		const hints = new Set(snapshot.hints.map((hint) => hint.id));
		for (const factId of candidate.fromFactIds) {
			if (!facts.has(factId)) throw new GraphServiceError("not_found", `fact ${factId} was not found in challenge`);
			if (hints.has(factId)) throw new GraphServiceError("validation", "hint IDs cannot be used as fromFactIds");
		}
		for (const hintId of candidate.sourceHintIds) {
			if (!hints.has(hintId)) throw new GraphServiceError("not_found", `hint ${hintId} was not found in challenge`);
		}
	}
}

export function openGraphService(options: {
	shadowEnabled?: boolean;
	writeEnabled?: boolean;
	leaseEnabled?: boolean;
	reasonerEnabled?: boolean;
	databasePath?: string;
	artifactRoot?: string;
	leaseTokenKeyPath?: string;
}): { store: GraphStore; service: GraphService } | undefined {
	if (options.shadowEnabled !== true || options.writeEnabled !== true) return;
	const store = new GraphStore(
		options.databasePath ?? resolve(homedir(), ".secheur-agent/cairn", "state", "graph.db"),
	);
	store.initialize();
	const leaseTokenSecret =
		options.leaseEnabled === true || options.reasonerEnabled === true
			? readOrCreateLeaseTokenSecret(
					options.leaseTokenKeyPath ??
						resolve(homedir(), ".secheur-agent/cairn", "secrets", "graph-lease-token.key"),
				)
			: undefined;
	return {
		store,
		service: new GraphService(store, {
			artifactRoot: options.artifactRoot,
			leaseTokenSecret,
			reasonerEnabled: options.reasonerEnabled,
		}),
	};
}

function readOrCreateLeaseTokenSecret(path: string): Uint8Array {
	mkdirSync(dirname(path), { recursive: true });
	try {
		return readFileSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const secret = randomBytes(32);
	try {
		writeFileSync(path, secret, { flag: "wx", mode: 0o600 });
		return secret;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		return readFileSync(path);
	}
}
