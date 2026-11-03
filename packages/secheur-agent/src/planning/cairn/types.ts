/** Adapted from sxd-git1/cairnpilot b015733fa117aa35f2406b8b31fd1bbf84d3ec6e.
 * Apache-2.0; see vendor/cairnpilot/LICENSE and NOTICE.md. */
export type FactKind =
	| "origin"
	| "goal"
	| "fact"
	| "evidence"
	| "failure_boundary"
	| "credential"
	| "asset"
	| "flag"
	| "constraint";

export type FactStatus = "active" | "invalidated";

export interface GraphFact {
	id: string;
	challengeId: string;
	kind: FactKind;
	statement: string;
	evidenceRefs: string[];
	sourceSolverId?: string;
	sourceMemoryIds: string[];
	producedByIntentId?: string;
	fingerprint: string;
	status: FactStatus;
	invalidatedByFactId?: string;
	observedAt: string;
	createdAt: string;
}

export interface GraphHint {
	id: string;
	challengeId: string;
	content: string;
	creator: string;
	sourceMemoryIds: string[];
	fingerprint: string;
	createdAt: string;
}

export type IntentStatus =
	| "proposed"
	| "open"
	| "claimed"
	| "running"
	| "blocked"
	| "concluded"
	| "superseded"
	| "cancelled";

export type IntentOutcome = "success" | "partial" | "failure" | "inconclusive";

export interface GraphIntent {
	id: string;
	challengeId: string;
	fromFactIds: string[];
	sourceHintIds: string[];
	objective: string;
	scope: string;
	capabilityTags: string[];
	priority: number;
	status: IntentStatus;
	outcome?: IntentOutcome;
	ownerSolverId?: string;
	leaseUntil?: string;
	resultFactIds: string[];
	attemptCount: number;
	version: number;
	createdBy: string;
	sourceIdeaIds: string[];
	fingerprint: string;
	createdAt: string;
	updatedAt: string;
}

export interface GraphEvent {
	sequence: number;
	challengeId: string;
	type: string;
	entityId: string;
	actorId: string;
	idempotencyKey: string;
	payload: unknown;
	createdAt: string;
}

export interface ChallengeGoalState {
	challengeId: string;
	completed: boolean;
	flagCount?: number;
	solvedFlagCount: number;
	updatedAt: string;
}

export interface ChallengeGraphSnapshot {
	challengeId: string;
	facts: GraphFact[];
	hints: GraphHint[];
	intents: GraphIntent[];
	goalState?: ChallengeGoalState;
}

export interface ShadowMigrationBatch {
	challengeId: string;
	capturedAt: string;
	snapshotFingerprint: string;
	facts: GraphFact[];
	hints: GraphHint[];
	intents: GraphIntent[];
	events: Array<Omit<GraphEvent, "sequence">>;
}

export interface ShadowMigrationWriteResult {
	insertedFacts: number;
	insertedHints: number;
	insertedIntents: number;
	insertedEvents: number;
	retiredFacts: number;
	retiredHints: number;
	retiredIntents: number;
	snapshotApplied: boolean;
}

export interface ShadowCountByKind {
	fact: number;
	evidence: number;
	failure: number;
	note: number;
	hint: number;
}

export interface ShadowCountByIdeaStatus {
	pending: number;
	testing: number;
	verified: number;
	failed: number;
	skipped: number;
}

export interface ShadowMigrationIssue {
	sourceType: "memory" | "idea";
	sourceId: string;
	message: string;
}

export interface ShadowMigrationReport {
	challengeId: string;
	memoryTotal: number;
	memoryByKind: ShadowCountByKind;
	ideaTotal: number;
	ideasByStatus: ShadowCountByIdeaStatus;
	factCount: number;
	hintCount: number;
	intentCount: number;
	ignoredNoteCount: number;
	duplicateMergedCount: number;
	statusMappingDifferenceCount: number;
	missingMemoryReferenceCount: number;
	unverifiableReferenceCount: number;
	issues: ShadowMigrationIssue[];
}

export type GraphActorRole = "host" | "solver" | "observer";
export type CandidateStatus = "proposed" | "confirmed" | "rejected" | "merged";

export interface GraphActor {
	id: string;
	role: GraphActorRole;
	challengeId: string;
}

export interface FactCandidate {
	id: string;
	challengeId: string;
	kind: FactKind;
	statement: string;
	confidence: number;
	evidenceRefs: string[];
	sourceEventIds: string[];
	sourceActorId: string;
	sourceRole: GraphActorRole;
	status: CandidateStatus;
	resultFactId?: string;
	mergedIntoCandidateId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface IntentCandidate {
	id: string;
	challengeId: string;
	objective: string;
	scope: string;
	confidence: number;
	fromFactIds: string[];
	sourceHintIds: string[];
	capabilityTags: string[];
	sourceEventIds: string[];
	sourceActorId: string;
	sourceRole: GraphActorRole;
	status: CandidateStatus;
	resultIntentId?: string;
	mergedIntoCandidateId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface GraphArtifact {
	id: string;
	challengeId: string;
	solverId: string;
	intentId?: string;
	path: string;
	sha256: string;
	mimeType: string;
	size: number;
	createdAt: string;
}

export interface GraphDelta {
	challengeId: string;
	afterSequence: number;
	latestSequence: number;
	nextSequence: number;
	hasMore: boolean;
	events: GraphEvent[];
}

export interface FocusedGraphContext {
	challengeId: string;
	goalState?: ChallengeGoalState;
	facts: GraphFact[];
	hints: GraphHint[];
	intents: GraphIntent[];
	delta: GraphEvent[];
	truncated: boolean;
}

export interface GraphBoardDifferenceReport {
	challengeId: string;
	memoryCount: number;
	ideaCount: number;
	activeFactCount: number;
	hintCount: number;
	confirmedIntentCount: number;
	countDifferences: {
		memoryMinusFactsAndHints: number;
		ideasMinusIntents: number;
	};
}

export type IntentClaimStatus = "active" | "released" | "expired" | "concluded" | "cancelled";

export interface IntentClaim {
	id: string;
	challengeId: string;
	intentId: string;
	solverId: string;
	tokenHash: string;
	generation: number;
	leaseUntil: string;
	heartbeatAt: string;
	status: IntentClaimStatus;
	createdAt: string;
	updatedAt: string;
}

export interface IntentLease {
	challengeId: string;
	intentId: string;
	solverId: string;
	token: string;
	generation: number;
	leaseUntil: string;
	version: number;
}

/** Public, token-free identity attached to one Solver Intent session. */
export interface IntentSessionTag {
	challengeId: string;
	intentId: string;
	generation: number;
	sessionEpoch: number;
}

export interface IntentResultFactInput {
	kind: FactKind;
	statement: string;
	evidenceRefs?: string[];
}

export interface IntentCheckpointResult {
	intentId: string;
	version: number;
	resultFactIds: string[];
}

export interface IntentConcludeResult extends IntentCheckpointResult {
	outcome: IntentOutcome;
}

export type ReasonTriggerReason =
	| "fact_confirmed"
	| "fact_invalidated"
	| "hint_added"
	| "intent_concluded"
	| "no_active_intents"
	| "initial_reason";

export type ReasonTriggerStatus = "pending" | "processing" | "completed" | "dead_letter";

export interface ReasonTrigger {
	id: string;
	challengeId: string;
	reason: ReasonTriggerReason;
	sourceEventSequence: number;
	sourceEntityId: string;
	payloadFingerprint: string;
	status: ReasonTriggerStatus;
	attemptCount: number;
	notBefore: string;
	leaseGeneration?: number;
	lastError?: string;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

export type ReasonLeaseStatus = "active" | "released" | "expired";

export interface ReasonLeaseRecord {
	challengeId: string;
	ownerId: string;
	generation: number;
	tokenHash: string;
	leaseUntil: string;
	heartbeatAt: string;
	status: ReasonLeaseStatus;
	createdAt: string;
	updatedAt: string;
}

export interface ReasonLease {
	challengeId: string;
	ownerId: string;
	generation: number;
	token: string;
	leaseUntil: string;
}

export type ReasonProposalStatus = "proposed" | "rejected" | "applied";

export interface ReasonProposedIntent {
	clientId: string;
	objective: string;
	successCriteria: string[];
	rationale: string;
	fromFactIds: string[];
	sourceHintIds: string[];
	capabilityTags: string[];
	priority: number;
	supersedesIntentIds: string[];
}

export interface ReasonSupersedeRecommendation {
	intentId: string;
	rationale: string;
	replacementClientId?: string;
}

export interface ReasonProposal {
	id: string;
	challengeId: string;
	status: ReasonProposalStatus;
	sourceTriggerIds: string[];
	reasonLeaseGeneration: number;
	baseEventSequence: number;
	contextFingerprint: string;
	rationaleSummary: string;
	proposedIntents: ReasonProposedIntent[];
	supersedeRecommendations: ReasonSupersedeRecommendation[];
	model: string;
	provider: string;
	promptVersion: string;
	createdAt: string;
	validationErrors: string[];
}

export type ReasonProposalApplyStatus = "applied" | "no_op" | "rejected_stale";

export interface ReasonProposalSkippedIntent {
	clientId: string;
	reason: string;
	duplicateIntentId?: string;
}

export interface ReasonProposalSkippedSupersede {
	intentId: string;
	reason: string;
	replacementClientId?: string;
}

export interface ReasonProposalApplyResult {
	proposalId: string;
	challengeId: string;
	status: ReasonProposalApplyStatus;
	createdIntentIds: string[];
	skippedIntents: ReasonProposalSkippedIntent[];
	supersededIntentIds: string[];
	skippedSupersedes: ReasonProposalSkippedSupersede[];
	staleReasons: string[];
	eventSequence: number;
	appliedAt: string;
}

export interface ReasonContextIntentSummary {
	id: string;
	objective: string;
	status: IntentStatus;
	outcome?: IntentOutcome;
	resultFactIds: string[];
	updatedAt: string;
}

export interface ReasonContext {
	challengeId: string;
	goalState?: ChallengeGoalState;
	activeFacts: GraphFact[];
	failureBoundaries: GraphFact[];
	hints: GraphHint[];
	activeIntents: GraphIntent[];
	recentTerminalIntents: ReasonContextIntentSummary[];
	triggers: ReasonTrigger[];
	baseEventSequence: number;
	truncated: boolean;
}

export interface ReasonContextEnvelope {
	context: ReasonContext;
	fingerprint: string;
}

export interface ReasonModelInput {
	prompt: string;
	promptVersion: string;
	maxOutputTokens?: number;
}

export interface ReasonModelOutput {
	text: string;
	model: string;
	provider: string;
}

export interface ReasonModel {
	generate(input: ReasonModelInput, signal: AbortSignal): Promise<ReasonModelOutput>;
}
