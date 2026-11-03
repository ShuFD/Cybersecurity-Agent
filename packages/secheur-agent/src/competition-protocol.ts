import { createHash } from "node:crypto";

export const COMPETITION_PROTOCOL = "secheur.competition/v1" as const;
export const COMPETITION_PROTOCOL_VERSION = 1 as const;

export type CompetitionTaskStatus =
	| "queued"
	| "assigned"
	| "preparing"
	| "running"
	| "verifying"
	| "solved"
	| "failed"
	| "blocked"
	| "environment_blocked"
	| "platform_closed"
	| "stopped";

export type CompetitionAuditVerdict =
	| "progressing"
	| "stalled"
	| "format_blocked"
	| "guessing"
	| "environment_blocked"
	| "solved";

export type CompetitionEventType =
	| "claim"
	| "heartbeat"
	| "evidence"
	| "progress_report"
	| "flag_candidate"
	| "submit_request"
	| "blocked"
	| "completed";

export type FlagCandidateMode = "full" | "inner" | "either";
export type FlagSubmissionMode = "full" | "inner";

export interface FlagFormat {
	prefix: string;
	suffix: string;
	accepts: FlagCandidateMode;
	submit: FlagSubmissionMode;
	pattern?: string;
	maxLength?: number;
}

export interface ArtifactRef {
	artifactId?: string;
	name: string;
	url: string;
	sizeBytes?: number;
	sha256?: string;
	mimeType?: string;
}

export interface EnvironmentAccess {
	required: boolean;
	status: "none" | "pending" | "ready" | "blocked" | "expired" | "released";
	endpoints: unknown[];
	leaseId?: string;
	expiresAt?: number;
}

export interface ScoreSnapshot {
	currentScore: number;
	challengeValue: number;
	difficulty?: number;
	estimatedSolveProbability: number;
	confidence: number;
	expectedRemainingMinutes: number;
	environmentWaitMinutes: number;
	agingBonus: number;
	asOf: number;
}

export interface SubmissionPolicy {
	flagFormat: FlagFormat;
	maxAttempts: number;
	duplicateScope: "task" | "challenge" | "competition";
	acceptedStatuses: string[];
	requestWrapper?: string;
}

export interface TaskLease {
	leaseId: string;
	ownerId: string;
	assignedAt: number;
	heartbeatAt: number;
	expiresAt: number;
}

export interface CompetitionPlan {
	planId: string;
	revision: number;
	orderedTaskIds: string[];
	rationale: string;
	generatedBy: string;
	generatedAt: number;
}

export interface CompetitionTaskPlan {
	planId: string;
	revision: number;
	rank: number;
	total: number;
}

export interface ChallengeSnapshot {
	exerciseId: string | number;
	name: string;
	category: string;
	description: string;
	hints: string[];
	flagFormat: FlagFormat;
	attachments: ArtifactRef[];
	environment: EnvironmentAccess;
	scoring: ScoreSnapshot;
	platform: Record<string, unknown>;
}

export interface CompetitionTaskEnvelope {
	taskId: string;
	assignmentId: string;
	shortTask: string;
	challenge: ChallengeSnapshot;
	submission: SubmissionPolicy;
	attemptBudget?: number;
	lease: TaskLease;
	policySnapshotId: string;
	plan?: CompetitionTaskPlan;
}

export interface ClaimEventPayload {
	taskId: string;
	leaseTtlMs?: number;
}

export interface HeartbeatEventPayload {
	leaseId: string;
	leaseTtlMs?: number;
}

export interface EvidenceEventPayload {
	evidenceId: string;
	kind: "observation" | "vulnerability_primitive" | "local_exploit" | "shell_proof" | "platform_accepted";
	summary: string;
	source: string;
	refs: string[];
	confidence?: number;
}

export interface ProgressReportPayload {
	status: "progressing" | "blocked" | "completed";
	summary: string;
	confidence: number;
	basis: string[];
}

export interface FlagCandidatePayload {
	candidate: string;
	evidenceRefs: string[];
	confidence: number;
	rationale: string;
}

export interface SubmitRequestPayload extends FlagCandidatePayload {
	clientSubmissionId?: string;
}

export interface BlockedEventPayload {
	reason: string;
	category: "solver" | "environment" | "platform" | "operator";
}

export interface CompletedEventPayload {
	summary: string;
	evidenceRefs: string[];
}

export type CompetitionEventPayload =
	| ClaimEventPayload
	| HeartbeatEventPayload
	| EvidenceEventPayload
	| ProgressReportPayload
	| FlagCandidatePayload
	| SubmitRequestPayload
	| BlockedEventPayload
	| CompletedEventPayload;

export interface CompetitionEvent<TPayload extends CompetitionEventPayload = CompetitionEventPayload> {
	protocol: typeof COMPETITION_PROTOCOL;
	version: typeof COMPETITION_PROTOCOL_VERSION;
	eventId: string;
	taskId: string;
	assignmentId: string;
	solverId: string;
	type: CompetitionEventType;
	occurredAt: number;
	payload: TPayload;
}

export interface CompetitionHelloRequest {
	protocol: typeof COMPETITION_PROTOCOL;
	version: typeof COMPETITION_PROTOCOL_VERSION;
	type: "hello";
	requestId: string;
	clientId: string;
}

export interface CompetitionCommandRequest {
	protocol: typeof COMPETITION_PROTOCOL;
	version: typeof COMPETITION_PROTOCOL_VERSION;
	type: "command";
	requestId: string;
	operation:
		| "status"
		| "configure_adapter"
		| "sync"
		| "list_tasks"
		| "list_events"
		| "get_task"
		| "get_plan"
		| "set_plan"
		| "clear_plan"
		| "set_attempt_budgets"
		| "requeue_tasks"
		| "claim"
		| "event"
		| "release_environment"
		| "stop_task";
	payload: Record<string, unknown>;
}

export type CompetitionRpcRequest = CompetitionHelloRequest | CompetitionCommandRequest;

export interface CompetitionRpcResponse {
	protocol: typeof COMPETITION_PROTOCOL;
	version: typeof COMPETITION_PROTOCOL_VERSION;
	requestId: string;
	ok: boolean;
	result?: unknown;
	error?: { code: string; message: string };
}

export class CompetitionProtocolError extends Error {
	readonly code: string;

	constructor(message: string, code = "invalid_message") {
		super(message);
		this.name = "CompetitionProtocolError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
	if (!isRecord(value)) throw new CompetitionProtocolError(`${name} must be an object`);
	return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
	const allowed = new Set(keys);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key))
			throw new CompetitionProtocolError(`${name} contains unknown field: ${key}`, "unknown_field");
	}
}

function stringValue(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0)
		throw new CompetitionProtocolError(`${name} must be a non-empty string`);
	return value;
}

function finiteNumber(value: unknown, name: string, minimum = Number.NEGATIVE_INFINITY): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
		throw new CompetitionProtocolError(`${name} must be a finite number`);
	}
	return value;
}

function boundedProbability(value: unknown, name: string): number {
	const result = finiteNumber(value, name, 0);
	if (result > 1) throw new CompetitionProtocolError(`${name} must be between 0 and 1`);
	return result;
}

function integerValue(value: unknown, name: string, minimum = 0): number {
	const result = finiteNumber(value, name, minimum);
	if (!Number.isSafeInteger(result)) throw new CompetitionProtocolError(`${name} must be a safe integer`);
	return result;
}

function stringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new CompetitionProtocolError(`${name} must be an array of strings`);
	}
	return [...value];
}

function jsonObject(value: unknown, name: string): Record<string, unknown> {
	return requireRecord(value, name);
}

export function parseFlagFormat(value: unknown): FlagFormat {
	const record = requireRecord(value, "flagFormat");
	exactKeys(record, ["prefix", "suffix", "accepts", "submit", "pattern", "maxLength"], "flagFormat");
	const accepts = record.accepts;
	const submit = record.submit;
	if (accepts !== "full" && accepts !== "inner" && accepts !== "either") {
		throw new CompetitionProtocolError("flagFormat.accepts is invalid");
	}
	if (submit !== "full" && submit !== "inner") throw new CompetitionProtocolError("flagFormat.submit is invalid");
	if (typeof record.prefix !== "string" || typeof record.suffix !== "string") {
		throw new CompetitionProtocolError("flagFormat.prefix and flagFormat.suffix must be strings");
	}
	const prefix = record.prefix;
	const suffix = record.suffix;
	const maxLength =
		record.maxLength === undefined ? undefined : integerValue(record.maxLength, "flagFormat.maxLength", 1);
	return {
		prefix,
		suffix,
		accepts,
		submit,
		...(typeof record.pattern === "string" && record.pattern ? { pattern: record.pattern } : {}),
		...(maxLength === undefined ? {} : { maxLength }),
	};
}

export function parseArtifactRef(value: unknown): ArtifactRef {
	const record = requireRecord(value, "artifact");
	exactKeys(record, ["artifactId", "name", "url", "sizeBytes", "sha256", "mimeType"], "artifact");
	const result: ArtifactRef = {
		name: stringValue(record.name, "artifact.name"),
		url: stringValue(record.url, "artifact.url"),
	};
	if (record.artifactId !== undefined) result.artifactId = stringValue(record.artifactId, "artifact.artifactId");
	if (record.sizeBytes !== undefined) result.sizeBytes = integerValue(record.sizeBytes, "artifact.sizeBytes");
	if (record.sha256 !== undefined) result.sha256 = stringValue(record.sha256, "artifact.sha256").toLowerCase();
	if (record.mimeType !== undefined) result.mimeType = stringValue(record.mimeType, "artifact.mimeType");
	return result;
}

export function parseTaskLease(value: unknown): TaskLease {
	const record = requireRecord(value, "lease");
	exactKeys(record, ["leaseId", "ownerId", "assignedAt", "heartbeatAt", "expiresAt"], "lease");
	return {
		leaseId: stringValue(record.leaseId, "lease.leaseId"),
		ownerId: stringValue(record.ownerId, "lease.ownerId"),
		assignedAt: integerValue(record.assignedAt, "lease.assignedAt"),
		heartbeatAt: integerValue(record.heartbeatAt, "lease.heartbeatAt"),
		expiresAt: integerValue(record.expiresAt, "lease.expiresAt"),
	};
}

function parseCompetitionTaskPlan(value: unknown): CompetitionTaskPlan {
	const record = requireRecord(value, "plan");
	exactKeys(record, ["planId", "revision", "rank", "total"], "plan");
	const revision = integerValue(record.revision, "plan.revision", 1);
	const rank = integerValue(record.rank, "plan.rank", 0);
	const total = integerValue(record.total, "plan.total", 1);
	if (rank >= total) throw new CompetitionProtocolError("plan.rank must be less than plan.total");
	return {
		planId: stringValue(record.planId, "plan.planId"),
		revision,
		rank,
		total,
	};
}

export function parseCompetitionTaskEnvelope(value: unknown): CompetitionTaskEnvelope {
	const record = requireRecord(value, "task envelope");
	exactKeys(
		record,
		[
			"taskId",
			"assignmentId",
			"shortTask",
			"challenge",
			"submission",
			"attemptBudget",
			"lease",
			"policySnapshotId",
			"plan",
		],
		"task envelope",
	);
	const challenge = requireRecord(record.challenge, "challenge");
	exactKeys(
		challenge,
		[
			"exerciseId",
			"name",
			"category",
			"description",
			"hints",
			"flagFormat",
			"attachments",
			"environment",
			"scoring",
			"platform",
		],
		"challenge",
	);
	const environment = requireRecord(challenge.environment, "challenge.environment");
	exactKeys(environment, ["required", "status", "endpoints", "leaseId", "expiresAt"], "challenge.environment");
	const environmentStatus = environment.status;
	if (!["none", "pending", "ready", "blocked", "expired", "released"].includes(String(environmentStatus))) {
		throw new CompetitionProtocolError("challenge.environment.status is invalid");
	}
	if (typeof environment.required !== "boolean")
		throw new CompetitionProtocolError("challenge.environment.required must be boolean");
	if (!Array.isArray(environment.endpoints))
		throw new CompetitionProtocolError("challenge.environment.endpoints must be an array");
	if (!Array.isArray(challenge.attachments))
		throw new CompetitionProtocolError("challenge.attachments must be an array");
	const scoring = requireRecord(challenge.scoring, "challenge.scoring");
	exactKeys(
		scoring,
		[
			"currentScore",
			"challengeValue",
			"difficulty",
			"estimatedSolveProbability",
			"confidence",
			"expectedRemainingMinutes",
			"environmentWaitMinutes",
			"agingBonus",
			"asOf",
		],
		"challenge.scoring",
	);
	const submission = requireRecord(record.submission, "submission");
	exactKeys(
		submission,
		["flagFormat", "maxAttempts", "duplicateScope", "acceptedStatuses", "requestWrapper"],
		"submission",
	);
	const duplicateScope = submission.duplicateScope;
	if (duplicateScope !== "task" && duplicateScope !== "challenge" && duplicateScope !== "competition") {
		throw new CompetitionProtocolError("submission.duplicateScope is invalid");
	}
	return {
		taskId: stringValue(record.taskId, "taskId"),
		assignmentId: stringValue(record.assignmentId, "assignmentId"),
		shortTask: stringValue(record.shortTask, "shortTask"),
		challenge: {
			exerciseId:
				typeof challenge.exerciseId === "string" || typeof challenge.exerciseId === "number"
					? challenge.exerciseId
					: (() => {
							throw new CompetitionProtocolError("challenge.exerciseId is invalid");
						})(),
			name: stringValue(challenge.name, "challenge.name"),
			category: stringValue(challenge.category, "challenge.category"),
			description: stringValue(challenge.description, "challenge.description"),
			hints: stringArray(challenge.hints, "challenge.hints"),
			flagFormat: parseFlagFormat(challenge.flagFormat),
			attachments: challenge.attachments.map(parseArtifactRef),
			environment: {
				required: environment.required,
				status: environmentStatus as EnvironmentAccess["status"],
				endpoints: [...environment.endpoints],
				...(environment.leaseId === undefined
					? {}
					: { leaseId: stringValue(environment.leaseId, "environment.leaseId") }),
				...(environment.expiresAt === undefined
					? {}
					: { expiresAt: integerValue(environment.expiresAt, "environment.expiresAt") }),
			},
			scoring: {
				currentScore: finiteNumber(scoring.currentScore, "scoring.currentScore"),
				challengeValue: finiteNumber(scoring.challengeValue, "scoring.challengeValue"),
				...(scoring.difficulty === undefined
					? {}
					: { difficulty: finiteNumber(scoring.difficulty, "scoring.difficulty", 0) }),
				estimatedSolveProbability: boundedProbability(
					scoring.estimatedSolveProbability,
					"scoring.estimatedSolveProbability",
				),
				confidence: boundedProbability(scoring.confidence, "scoring.confidence"),
				expectedRemainingMinutes: finiteNumber(
					scoring.expectedRemainingMinutes,
					"scoring.expectedRemainingMinutes",
					0,
				),
				environmentWaitMinutes: finiteNumber(scoring.environmentWaitMinutes, "scoring.environmentWaitMinutes", 0),
				agingBonus: finiteNumber(scoring.agingBonus, "scoring.agingBonus", 0),
				asOf: integerValue(scoring.asOf, "scoring.asOf"),
			},
			platform: jsonObject(challenge.platform, "challenge.platform"),
		},
		submission: {
			flagFormat: parseFlagFormat(submission.flagFormat),
			maxAttempts: integerValue(submission.maxAttempts, "submission.maxAttempts", 1),
			duplicateScope,
			acceptedStatuses: stringArray(submission.acceptedStatuses, "submission.acceptedStatuses"),
			...(submission.requestWrapper === undefined
				? {}
				: { requestWrapper: stringValue(submission.requestWrapper, "submission.requestWrapper") }),
		},
		...(record.attemptBudget === undefined
			? {}
			: { attemptBudget: integerValue(record.attemptBudget, "attemptBudget", 1) }),
		lease: parseTaskLease(record.lease),
		policySnapshotId: stringValue(record.policySnapshotId, "policySnapshotId"),
		...(record.plan === undefined ? {} : { plan: parseCompetitionTaskPlan(record.plan) }),
	};
}

function eventPayload(type: CompetitionEventType, value: unknown): CompetitionEventPayload {
	const payload = requireRecord(value, `${type}.payload`);
	if (type === "claim") {
		exactKeys(payload, ["taskId", "leaseTtlMs"], "claim.payload");
		return {
			taskId: stringValue(payload.taskId, "claim.taskId"),
			...(payload.leaseTtlMs === undefined
				? {}
				: { leaseTtlMs: integerValue(payload.leaseTtlMs, "claim.leaseTtlMs", 1) }),
		};
	}
	if (type === "heartbeat") {
		exactKeys(payload, ["leaseId", "leaseTtlMs"], "heartbeat.payload");
		return {
			leaseId: stringValue(payload.leaseId, "heartbeat.leaseId"),
			...(payload.leaseTtlMs === undefined
				? {}
				: { leaseTtlMs: integerValue(payload.leaseTtlMs, "heartbeat.leaseTtlMs", 1) }),
		};
	}
	if (type === "evidence") {
		exactKeys(payload, ["evidenceId", "kind", "summary", "source", "refs", "confidence"], "evidence.payload");
		const kind = payload.kind;
		if (
			!["observation", "vulnerability_primitive", "local_exploit", "shell_proof", "platform_accepted"].includes(
				String(kind),
			)
		) {
			throw new CompetitionProtocolError("evidence.kind is invalid");
		}
		return {
			evidenceId: stringValue(payload.evidenceId, "evidence.evidenceId"),
			kind: kind as EvidenceEventPayload["kind"],
			summary: stringValue(payload.summary, "evidence.summary"),
			source: stringValue(payload.source, "evidence.source"),
			refs: stringArray(payload.refs, "evidence.refs"),
			...(payload.confidence === undefined
				? {}
				: { confidence: boundedProbability(payload.confidence, "evidence.confidence") }),
		};
	}
	if (type === "progress_report") {
		exactKeys(payload, ["status", "summary", "confidence", "basis"], "progress_report.payload");
		if (!["progressing", "blocked", "completed"].includes(String(payload.status)))
			throw new CompetitionProtocolError("progress_report.status is invalid");
		return {
			status: payload.status as ProgressReportPayload["status"],
			summary: stringValue(payload.summary, "progress_report.summary"),
			confidence: boundedProbability(payload.confidence, "progress_report.confidence"),
			basis: stringArray(payload.basis, "progress_report.basis"),
		};
	}
	if (type === "flag_candidate" || type === "submit_request") {
		exactKeys(
			payload,
			["candidate", "evidenceRefs", "confidence", "rationale", "clientSubmissionId"],
			`${type}.payload`,
		);
		const result: SubmitRequestPayload = {
			candidate: stringValue(payload.candidate, `${type}.candidate`),
			evidenceRefs: stringArray(payload.evidenceRefs, `${type}.evidenceRefs`),
			confidence: boundedProbability(payload.confidence, `${type}.confidence`),
			rationale: stringValue(payload.rationale, `${type}.rationale`),
		};
		if (payload.clientSubmissionId !== undefined)
			result.clientSubmissionId = stringValue(payload.clientSubmissionId, `${type}.clientSubmissionId`);
		return type === "flag_candidate" ? result : result;
	}
	if (type === "blocked") {
		exactKeys(payload, ["reason", "category"], "blocked.payload");
		if (!["solver", "environment", "platform", "operator"].includes(String(payload.category)))
			throw new CompetitionProtocolError("blocked.category is invalid");
		return {
			reason: stringValue(payload.reason, "blocked.reason"),
			category: payload.category as BlockedEventPayload["category"],
		};
	}
	exactKeys(payload, ["summary", "evidenceRefs"], "completed.payload");
	return {
		summary: stringValue(payload.summary, "completed.summary"),
		evidenceRefs: stringArray(payload.evidenceRefs, "completed.evidenceRefs"),
	};
}

export function parseCompetitionEvent(value: unknown): CompetitionEvent {
	const record = requireRecord(value, "competition event");
	exactKeys(
		record,
		["protocol", "version", "eventId", "taskId", "assignmentId", "solverId", "type", "occurredAt", "payload"],
		"competition event",
	);
	assertProtocol(record);
	const type = record.type;
	if (
		![
			"claim",
			"heartbeat",
			"evidence",
			"progress_report",
			"flag_candidate",
			"submit_request",
			"blocked",
			"completed",
		].includes(String(type))
	) {
		throw new CompetitionProtocolError("competition event type is invalid");
	}
	return {
		protocol: COMPETITION_PROTOCOL,
		version: COMPETITION_PROTOCOL_VERSION,
		eventId: stringValue(record.eventId, "eventId"),
		taskId: stringValue(record.taskId, "taskId"),
		assignmentId: stringValue(record.assignmentId, "assignmentId"),
		solverId: stringValue(record.solverId, "solverId"),
		type: type as CompetitionEventType,
		occurredAt: integerValue(record.occurredAt, "occurredAt"),
		payload: eventPayload(type as CompetitionEventType, record.payload),
	};
}

function assertProtocol(record: Record<string, unknown>): void {
	if (record.protocol !== COMPETITION_PROTOCOL)
		throw new CompetitionProtocolError("unsupported competition protocol", "unknown_version");
	if (record.version !== COMPETITION_PROTOCOL_VERSION)
		throw new CompetitionProtocolError("unsupported competition protocol version", "unknown_version");
}

export function parseCompetitionRpcRequest(value: unknown): CompetitionRpcRequest {
	const record = requireRecord(value, "competition request");
	const type = record.type;
	if (type === "hello") {
		exactKeys(record, ["protocol", "version", "type", "requestId", "clientId"], "competition hello");
		assertProtocol(record);
		return {
			protocol: COMPETITION_PROTOCOL,
			version: COMPETITION_PROTOCOL_VERSION,
			type: "hello",
			requestId: stringValue(record.requestId, "requestId"),
			clientId: stringValue(record.clientId, "clientId"),
		};
	}
	if (type !== "command") throw new CompetitionProtocolError("competition request type is invalid");
	exactKeys(record, ["protocol", "version", "type", "requestId", "operation", "payload"], "competition command");
	assertProtocol(record);
	const operation = record.operation;
	if (
		![
			"status",
			"configure_adapter",
			"sync",
			"list_tasks",
			"list_events",
			"get_task",
			"get_plan",
			"set_plan",
			"clear_plan",
			"set_attempt_budgets",
			"requeue_tasks",
			"claim",
			"event",
			"release_environment",
			"stop_task",
		].includes(String(operation))
	) {
		throw new CompetitionProtocolError("competition operation is invalid");
	}
	const payload = jsonObject(record.payload, "payload");
	if (operation === "configure_adapter") {
		exactKeys(
			payload,
			[
				"platform",
				"transport",
				"baseUrl",
				"agentApiUrl",
				"environmentGatewayUrl",
				"authScheme",
				"accessKey",
				"apiToken",
				"accessKeyEnv",
				"apiTokenEnv",
				"useEnvironmentCredentials",
				"force",
			],
			"configure_adapter.payload",
		);
		if (payload.platform !== undefined && payload.platform !== "ctfd" && payload.platform !== "slab")
			throw new CompetitionProtocolError("configure_adapter.platform is invalid");
		if (payload.transport !== undefined && payload.transport !== "agent_api" && payload.transport !== "ctfd_api")
			throw new CompetitionProtocolError("configure_adapter.transport is invalid");
		if (payload.authScheme !== undefined && payload.authScheme !== "Token" && payload.authScheme !== "Bearer")
			throw new CompetitionProtocolError("configure_adapter.authScheme is invalid");
		for (const key of [
			"baseUrl",
			"agentApiUrl",
			"environmentGatewayUrl",
			"accessKey",
			"apiToken",
			"accessKeyEnv",
			"apiTokenEnv",
		] as const) {
			if (payload[key] !== undefined) stringValue(payload[key], `configure_adapter.${key}`);
		}
		for (const key of ["useEnvironmentCredentials", "force"] as const) {
			if (payload[key] !== undefined && typeof payload[key] !== "boolean")
				throw new CompetitionProtocolError(`configure_adapter.${key} must be a boolean`);
		}
	}
	if (operation === "set_plan") {
		exactKeys(payload, ["taskIds", "rationale", "generatedBy", "expectedRevision"], "set_plan.payload");
		const taskIds = stringArray(payload.taskIds, "set_plan.taskIds");
		if (taskIds.length === 0) throw new CompetitionProtocolError("set_plan.taskIds must not be empty");
		stringValue(payload.rationale, "set_plan.rationale");
		if (payload.generatedBy !== undefined) stringValue(payload.generatedBy, "set_plan.generatedBy");
		if (payload.expectedRevision !== undefined) integerValue(payload.expectedRevision, "set_plan.expectedRevision");
	}
	if (operation === "clear_plan") exactKeys(payload, [], "clear_plan.payload");
	if (operation === "set_attempt_budgets") {
		exactKeys(payload, ["budgets"], "set_attempt_budgets.payload");
		if (!Array.isArray(payload.budgets))
			throw new CompetitionProtocolError("set_attempt_budgets.budgets must be an array");
	}
	if (operation === "requeue_tasks") {
		exactKeys(payload, ["taskIds", "reason"], "requeue_tasks.payload");
		const taskIds = stringArray(payload.taskIds, "requeue_tasks.taskIds");
		if (taskIds.length === 0) throw new CompetitionProtocolError("requeue_tasks.taskIds must not be empty");
		if (payload.reason !== undefined) stringValue(payload.reason, "requeue_tasks.reason");
	}
	return {
		protocol: COMPETITION_PROTOCOL,
		version: COMPETITION_PROTOCOL_VERSION,
		type: "command",
		requestId: stringValue(record.requestId, "requestId"),
		operation: operation as CompetitionCommandRequest["operation"],
		payload,
	};
}

export function formatFlagCandidate(candidate: string, format: FlagFormat): { normalized: string; submitted: string } {
	const trimmed = candidate.trim();
	const hasWrapper =
		(format.prefix.length > 0 || format.suffix.length > 0) &&
		trimmed.startsWith(format.prefix) &&
		trimmed.endsWith(format.suffix);
	const inner = hasWrapper ? trimmed.slice(format.prefix.length, trimmed.length - format.suffix.length) : trimmed;
	if (!inner) throw new CompetitionProtocolError("flag must not be empty", "format_mismatch");
	if (format.maxLength !== undefined && inner.length > format.maxLength)
		throw new CompetitionProtocolError("flag exceeds maximum length", "format_mismatch");
	if (format.accepts === "full" && (format.prefix.length > 0 || format.suffix.length > 0) && !hasWrapper) {
		throw new CompetitionProtocolError("flag wrapper is required", "format_mismatch");
	}
	if (format.accepts === "inner" && hasWrapper)
		throw new CompetitionProtocolError("flag wrapper is not accepted", "format_mismatch");
	if (format.pattern) {
		let pattern: RegExp;
		try {
			pattern = new RegExp(format.pattern, "u");
		} catch {
			throw new CompetitionProtocolError("flag format pattern is invalid", "format_mismatch");
		}
		if (!pattern.test(inner))
			throw new CompetitionProtocolError("flag does not match the challenge format", "format_mismatch");
	}
	return {
		normalized: inner,
		submitted: format.submit === "full" ? `${format.prefix}${inner}${format.suffix}` : inner,
	};
}

export function sha256Text(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}
