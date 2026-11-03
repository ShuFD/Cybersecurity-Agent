import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// OpenCode uses three identical calls for doom-loop detection and a five-second
// abort grace. Recovery reminders never stop the agent.
export const REPEAT_CALL_THRESHOLD = 3;
export const ABORT_GRACE_MS = 5_000;
// The deployed verifier contract, never an agent-tunable allowance.
export const VERIFICATION_ATTEMPTS = 3;
const OBSERVATION_TOOLS = new Set([
	"bash",
	"code_run",
	"read",
	"file_read",
	"file_write",
	"write",
	"edit",
	"web_fetch",
	"ctf_verb_call",
	"web_verb_call",
]);
interface Ledger {
	version: 1;
	evidence: string[];
	evidenceRevision: number;
	lastVerificationRevision: number;
	candidates: string[];
	attemptsUsed: number;
	idleRecoveries: number;
	turnsUsed: number;
	toolCallsUsed?: number;
	costUsed: number;
	checkpoint: string;
	verificationSettlements?: Record<string, "correct" | "incorrect" | "unavailable">;
	externalVerificationQuotaExhausted?: boolean;
}
export function operationalDigest(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(value) ?? "null")
		.digest("hex");
}
export async function boundedAbort(operation: Promise<unknown>, graceMs = ABORT_GRACE_MS): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation.then(
				() => true,
				() => true,
			),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), graceMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
export class OperationalGuard {
	private readonly path: string;
	private data: Ledger = {
		version: 1,
		evidence: [],
		evidenceRevision: 0,
		lastVerificationRevision: -1,
		candidates: [],
		attemptsUsed: 0,
		idleRecoveries: 0,
		turnsUsed: 0,
		costUsed: 0,
		checkpoint: "",
	};
	private lastCall = "";
	private repeats = 0;
	private readonly pendingVerifications = new Set<string>();
	private readonly verificationListeners = new Set<() => void>();
	constructor(storageRoot: string, scope: string) {
		this.path = join(storageRoot, "operational-runs", `${operationalDigest(scope)}.json`);
		if (existsSync(this.path)) {
			const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
			if (!value || typeof value !== "object") throw new Error("Invalid operational ledger");
			const record = value as Ledger;
			if (
				record.version !== 1 ||
				!Array.isArray(record.evidence) ||
				!Array.isArray(record.candidates) ||
				![
					record.evidenceRevision,
					record.lastVerificationRevision,
					record.attemptsUsed,
					record.idleRecoveries,
					record.turnsUsed,
				].every(Number.isSafeInteger) ||
				record.attemptsUsed < 0 ||
				record.turnsUsed < 0 ||
				(record.toolCallsUsed !== undefined &&
					(!Number.isSafeInteger(record.toolCallsUsed) || record.toolCallsUsed < 0)) ||
				!Number.isFinite(record.costUsed) ||
				record.costUsed < 0 ||
				typeof record.checkpoint !== "string"
			)
				throw new Error("Invalid operational ledger; refusing to reset budgets");
			if (
				record.externalVerificationQuotaExhausted !== undefined &&
				typeof record.externalVerificationQuotaExhausted !== "boolean"
			)
				throw new Error("Invalid verification quota marker; refusing to reset budgets");
			if (
				record.verificationSettlements !== undefined &&
				(!record.verificationSettlements ||
					typeof record.verificationSettlements !== "object" ||
					Array.isArray(record.verificationSettlements) ||
					Object.entries(record.verificationSettlements).some(
						([key, value]) =>
							!record.candidates.includes(key) || !["correct", "incorrect", "unavailable"].includes(value),
					))
			)
				throw new Error("Invalid verification settlements; refusing to reset budgets");
			this.data = record;
		}
	}
	private save(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const temp = `${this.path}.tmp`;
		writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 });
		renameSync(temp, this.path);
	}
	get toolCallsUsed(): number {
		return this.data.toolCallsUsed ?? 0;
	}
	recordToolCall(): void {
		this.data.toolCallsUsed = this.toolCallsUsed + 1;
		this.save();
	}
	get turnsUsed(): number {
		return this.data.turnsUsed;
	}
	get costUsed(): number {
		return this.data.costUsed;
	}
	setCostUsed(cost: number): void {
		this.data.costUsed = cost;
		this.save();
	}
	setTurnsUsed(turns: number): void {
		this.data.turnsUsed = turns;
		this.save();
	}
	get remainingAttempts(): number {
		if (this.data.externalVerificationQuotaExhausted) return 0;
		return Math.max(0, VERIFICATION_ATTEMPTS - this.data.attemptsUsed);
	}
	get verificationState(): "running" | "pending" | "accepted" | "quota_exhausted" {
		if (Object.values(this.data.verificationSettlements ?? {}).includes("correct")) return "accepted";
		if (this.remainingAttempts > 0) return "running";
		return this.pendingVerifications.size > 0 ? "pending" : "quota_exhausted";
	}
	onVerificationSettlement(listener: () => void): () => void {
		this.verificationListeners.add(listener);
		return () => this.verificationListeners.delete(listener);
	}
	settleVerification(
		candidate: string,
		outcome: "correct" | "incorrect" | "unavailable",
		quotaExhausted = false,
	): void {
		const digest = operationalDigest(candidate);
		if (!this.data.candidates.includes(digest)) throw new Error("Verification has no durable reservation");
		this.data.verificationSettlements ??= {};
		const previous = this.data.verificationSettlements[digest];
		if (previous && previous !== outcome) throw new Error("Conflicting verification settlement");
		this.data.verificationSettlements[digest] = outcome;
		if (quotaExhausted) this.data.externalVerificationQuotaExhausted = true;
		this.pendingVerifications.delete(digest);
		this.save();
		for (const listener of this.verificationListeners) listener();
	}
	async waitForVerificationSettlement(signal?: AbortSignal): Promise<void> {
		if (this.verificationState !== "pending") return;
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				unsubscribe();
				signal?.removeEventListener("abort", abort);
			};
			const abort = () => {
				cleanup();
				reject(signal?.reason ?? new Error("Verification wait aborted"));
			};
			const unsubscribe = this.onVerificationSettlement(() => {
				if (this.verificationState !== "pending") {
					cleanup();
					resolve();
				}
			});
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
		});
	}
	observe(tool: string, input: unknown, content: unknown, isError: boolean, details?: unknown): void {
		if (tool === "update_working_checkpoint" && !isError) {
			this.data.checkpoint = JSON.stringify(input).slice(0, 4000);
			this.save();
		}
		if (isError || !OBSERVATION_TOOLS.has(tool)) return;
		const meta = details && typeof details === "object" ? (details as Record<string, unknown>) : {};
		const nested = meta.data && typeof meta.data === "object" ? (meta.data as Record<string, unknown>) : {};
		if (
			["running", "failed", "error", "cancelled", "stopping", "blocked", "not_found"].includes(
				String(meta.status),
			) ||
			["running", "failed", "error", "cancelled", "stopping", "blocked", "not_found"].includes(
				String(nested.status),
			) ||
			meta.unchanged === true ||
			(typeof meta.exitCode === "number" && meta.exitCode !== 0)
		)
			return;
		// Merely changing command text is not new evidence; output must change.
		const digest = operationalDigest(content);
		if (this.data.evidence.includes(digest)) return;
		this.data.evidence.push(digest);
		this.data.evidenceRevision += 1;
		this.repeats = 0;
		this.save();
	}
	repeatedCall(tool: string, input: unknown): boolean {
		if (!OBSERVATION_TOOLS.has(tool)) return false;
		const digest = operationalDigest([tool, input]);
		this.repeats = digest === this.lastCall ? this.repeats + 1 : 1;
		this.lastCall = digest;
		return this.repeats >= REPEAT_CALL_THRESHOLD;
	}
	reserveVerification(candidate: string): "allowed" | "duplicate" | "quota_exhausted" {
		const digest = operationalDigest(candidate);
		if (this.data.candidates.includes(digest)) return "duplicate";
		if (!this.remainingAttempts) return "quota_exhausted";
		// Reserve durably before network I/O; ambiguous transport failures must not
		// silently reset a quota that the remote proxy may already have spent.
		this.data.candidates.push(digest);
		this.data.attemptsUsed += 1;
		this.data.lastVerificationRevision = this.data.evidenceRevision;
		this.save();
		this.pendingVerifications.add(digest);
		return "allowed";
	}
	takeRecovery(): boolean {
		this.data.idleRecoveries += 1;
		this.save();
		return true;
	}
	context(pending = "", options: { includeCheckpoint?: boolean } = {}): string {
		return `[Operational checkpoint]\nVerification attempts remaining: ${this.remainingAttempts}/${VERIFICATION_ATTEMPTS}. Use existing evidence and verifier feedback to correct candidates; identical candidates remain blocked. Stop when verification attempts are exhausted. Other verifier failures disable verification only; continue working until verified success or an external budget/cancellation.\nTurns already used: ${this.turnsUsed}. Recovery does not reset budgets.\n${options.includeCheckpoint === false ? "Task progress is supplied by the task-scoped PLAN handoff; the legacy shared checkpoint is not this task's state." : `Checkpoint: ${this.data.checkpoint || "No explicit checkpoint saved; use existing session history."}`}\n${pending || "No running background commands."}`;
	}
}
