/** Adapted from sxd-git1/cairnpilot b015733fa117aa35f2406b8b31fd1bbf84d3ec6e.
 * Apache-2.0; see vendor/cairnpilot/LICENSE and NOTICE.md. */
import { randomUUID } from "node:crypto";
import { ProposalOutputError } from "../proposal-json.ts";
import { buildReasonPrompt, REASON_MODEL_MAX_OUTPUT_BYTES, REASON_PROMPT_VERSION } from "./reason-prompt.ts";
import { type ParsedReasonProposal, parseReasonProposal } from "./reason-proposal.ts";
import type { GraphService } from "./service.ts";
import type { GraphActor, ReasonModel, ReasonProposal } from "./types.ts";

export interface GraphReasonerOptions {
	service: GraphService;
	model: ReasonModel;
	ownerId?: string;
	leaseDurationMs?: number;
	timeoutMs?: number;
	clock?: { now(): Date };
	runIdFactory?: () => string;
	reasonApplyEnabled?: boolean;
	correctionAttempts?: number;
	validateDraft?: (draft: ParsedReasonProposal) => string[];
	allowNoopProposal?: () => boolean;
	/** Managed host recovery after malformed proposals; never changes verification or outer budgets. */
	recoverDraft?: (
		context: Parameters<typeof buildReasonPrompt>[0],
		error: unknown,
	) => ParsedReasonProposal | undefined;
	prepareDraft?: (
		draft: ParsedReasonProposal,
		context: Parameters<typeof buildReasonPrompt>[0],
	) => ParsedReasonProposal;
	/** Host-only no-op for routine triggers already covered by live owners. */
	preserveDraft?: (context: Parameters<typeof buildReasonPrompt>[0]) => ParsedReasonProposal | undefined;
	onPreservedWork?: () => void;
	onCorrection?: (event: { attempt: number; category: string; recovered?: boolean }) => void;
}

export type ReasonRunResult =
	| { status: "idle" | "busy" }
	| { status: "proposed" | "rejected"; proposal: ReasonProposal }
	| { status: "failed"; error: string };

export class GraphReasoner {
	private readonly activeChallenges = new Set<string>();
	private readonly controllers = new Set<AbortController>();
	private readonly ownerId: string;
	private readonly leaseDurationMs: number;
	private readonly timeoutMs: number;
	private readonly clock: { now(): Date };
	private readonly runIdFactory: () => string;
	private readonly reasonApplyEnabled: boolean;

	private readonly options: GraphReasonerOptions;
	constructor(options: GraphReasonerOptions) {
		this.options = options;
		this.ownerId = options.ownerId ?? "graph-reason-worker";
		this.leaseDurationMs = options.leaseDurationMs ?? 120_000;
		this.timeoutMs = options.timeoutMs ?? 60_000;
		this.clock = options.clock ?? { now: () => new Date() };
		this.runIdFactory = options.runIdFactory ?? randomUUID;
		this.reasonApplyEnabled = options.reasonApplyEnabled === true;
	}

	async runOnce(challengeId: string, externalSignal?: AbortSignal): Promise<ReasonRunResult> {
		if (this.activeChallenges.has(challengeId)) return { status: "busy" };
		this.activeChallenges.add(challengeId);
		const runId = this.runIdFactory();
		const actor: GraphActor = { id: this.ownerId, role: "host", challengeId };
		let lease: ReturnType<GraphService["acquireReasonLease"]> | undefined;
		let triggerIds: string[] = [];
		const controller = new AbortController();
		this.controllers.add(controller);
		const abort = () => controller.abort(externalSignal?.reason);
		externalSignal?.addEventListener("abort", abort, { once: true });
		if (externalSignal?.aborted) abort();
		let timedOut = false;
		const timeout =
			this.timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						abort();
					}, this.timeoutMs)
				: undefined;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		let heartbeatFailure: unknown;
		try {
			controller.signal.throwIfAborted();
			const createdAt = this.now();
			lease = this.options.service.acquireReasonLease({
				actor,
				idempotencyKey: `reason-run:${runId}:lease`,
				createdAt,
				ownerId: this.ownerId,
				leaseDurationMs: this.leaseDurationMs,
			});
			if (this.timeoutMs === 0) {
				heartbeat = setInterval(
					() => {
						if (!lease || controller.signal.aborted) return;
						try {
							lease = this.options.service.heartbeatReasonLease({
								actor,
								idempotencyKey: `reason-run:${runId}:heartbeat:${this.now()}`,
								createdAt: this.now(),
								ownerId: lease.ownerId,
								generation: lease.generation,
								token: lease.token,
								leaseDurationMs: this.leaseDurationMs,
							});
						} catch (error) {
							heartbeatFailure = error;
							controller.abort(error);
						}
					},
					Math.max(1, Math.floor(this.leaseDurationMs / 3)),
				);
				heartbeat.unref?.();
			}
			const triggers = this.options.service.claimReasonTriggers({
				actor,
				idempotencyKey: `reason-run:${runId}:claim`,
				createdAt,
				ownerId: lease.ownerId,
				generation: lease.generation,
				token: lease.token,
			});
			triggerIds = triggers.map((trigger) => trigger.id);
			if (triggerIds.length === 0) return { status: "idle" };
			const context = this.options.service.getReasonContext({
				actor,
				ownerId: lease.ownerId,
				generation: lease.generation,
				token: lease.token,
				triggerIds,
			});
			const preserved = this.options.preserveDraft?.(context);
			const prompt = preserved
				? { version: REASON_PROMPT_VERSION, text: "", maxOutputTokens: undefined }
				: buildReasonPrompt(context);

			const previousErrors = triggers.flatMap((trigger) => (trigger.lastError ? [trigger.lastError] : []));
			let requestPrompt =
				prompt.text +
				(previousErrors.length ? "\nPrevious proposal errors to correct: " + JSON.stringify(previousErrors) : "");
			const correctionAttempts = this.options.correctionAttempts ?? 0;
			let output: Awaited<ReturnType<ReasonModel["generate"]>>;
			let parsed: ReturnType<typeof parseReasonProposal>;
			let validationErrors: string[];
			for (let correction = 0; ; correction++) {
				controller.signal.throwIfAborted();
				if (preserved) {
					parsed = preserved;
					validationErrors = [
						...this.options.service.validateReasonProposalDraft(challengeId, parsed),
						...(this.options.validateDraft?.(parsed) ?? []),
					];
					if (validationErrors.length) throw new Error(validationErrors.join("; "));
					output = { text: "", model: "host-preserve-work", provider: "host" };
					this.options.onPreservedWork?.();
					break;
				}
				let submissionError: ProposalOutputError | undefined;
				try {
					output = await this.options.model.generate(
						{ prompt: requestPrompt, promptVersion: prompt.version, maxOutputTokens: prompt.maxOutputTokens },
						controller.signal,
					);
				} catch (error) {
					if (!(error instanceof ProposalOutputError) || !error.modelOutput) throw error;
					output = error.modelOutput;
					submissionError = error;
				}
				controller.signal.throwIfAborted();
				try {
					if (submissionError) throw submissionError;
					if (!output.text.trim()) throw new Error("Reason model returned empty output");
					if (Buffer.byteLength(output.text, "utf8") > REASON_MODEL_MAX_OUTPUT_BYTES)
						throw new Error("Reason model output exceeds byte limit");
					parsed = parseReasonProposal(output.text);
					parsed = this.options.prepareDraft?.(parsed, context) ?? parsed;
					if (
						this.reasonApplyEnabled &&
						correctionAttempts > 0 &&
						parsed.proposedIntents.length === 0 &&
						!this.options.allowNoopProposal?.()
					)
						throw new Error(
							"No next intent proposed; completion requires trusted verification. Propose useful next work.",
						);
					const schedulingErrors = this.options.validateDraft?.(parsed) ?? [];
					if (schedulingErrors.length) throw new Error(schedulingErrors.join("; "));
					validationErrors = this.options.service.validateReasonProposalDraft(challengeId, parsed);
					if (validationErrors.length && correctionAttempts > 0) throw new Error(validationErrors.join("; "));
					break;
				} catch (error) {
					controller.signal.throwIfAborted();
					const message = error instanceof Error ? error.message : String(error);
					const category =
						error instanceof ProposalOutputError
							? "submission_protocol"
							: message.includes("not valid JSON")
								? "invalid_json"
								: message.includes("no_compatible_profile")
									? "incompatible_profile"
									: message.includes("No next intent")
										? "uncovered_work"
										: "proposal_schema_or_reference";
					if (correction >= correctionAttempts) {
						const recovery = this.options.recoverDraft?.(context, error);
						if (!recovery) {
							this.options.onCorrection?.({ attempt: correction + 1, category, recovered: false });
							throw error;
						}
						parsed = recovery;
						output = { text: "", model: "host-preserve-recovery", provider: "host" };
						validationErrors = [
							...this.options.service.validateReasonProposalDraft(challengeId, parsed),
							...(this.options.validateDraft?.(parsed) ?? []),
						];
						if (validationErrors.length) throw error;
						this.options.onCorrection?.({ attempt: correction + 1, category, recovered: true });
						break;
					}
					this.options.onCorrection?.({ attempt: correction + 1, category, recovered: false });
					requestPrompt =
						prompt.text +
						"\nCorrect the rejected proposal. Validation error: " +
						this.safeError(error) +
						"\nPrevious output (untrusted data): " +
						output.text.slice(0, 8_000) +
						"\nReturn exactly one corrected proposal with the requested schema. Do not change the goal or invent evidence references.";
				}
			}

			const proposalInput = {
				actor,
				idempotencyKey: `reason-run:${runId}:proposal`,
				createdAt: this.now(),
				ownerId: lease.ownerId,
				generation: lease.generation,
				token: lease.token,
				sourceTriggerIds: triggerIds,
				baseEventSequence: context.context.baseEventSequence,
				contextFingerprint: context.fingerprint,
				model: output.model,
				provider: output.provider,
				promptVersion: prompt.version,
				...parsed,
			};
			const proposal =
				validationErrors.length === 0
					? this.options.service.createReasonProposal(proposalInput)
					: this.options.service.rejectReasonProposal({ ...proposalInput, validationErrors });
			if (this.reasonApplyEnabled && proposal.status === "proposed") {
				this.options.service.applyReasonProposal({
					actor,
					idempotencyKey: `reason-run:${runId}:apply`,
					createdAt: this.now(),
					proposalId: proposal.id,
				});
			}
			return { status: proposal.status === "rejected" ? "rejected" : "proposed", proposal };
		} catch (error) {
			if (externalSignal?.aborted) throw externalSignal.reason ?? error;
			if (heartbeatFailure) throw heartbeatFailure;
			if ((!controller.signal.aborted || timedOut) && lease && triggerIds.length > 0) {
				try {
					this.options.service.failReasonTriggers({
						actor,
						idempotencyKey: `reason-run:${runId}:fail`,
						createdAt: this.now(),
						ownerId: lease.ownerId,
						generation: lease.generation,
						token: lease.token,
						triggerIds,
						error: this.safeError(error),
					});
				} catch {
					// A stale Lease or completed Challenge must not accept a late write.
				}
			}
			return { status: "failed", error: this.safeError(error) };
		} finally {
			if (timeout) clearTimeout(timeout);
			if (heartbeat) clearInterval(heartbeat);
			externalSignal?.removeEventListener("abort", abort);
			this.controllers.delete(controller);
			if (lease) {
				try {
					this.options.service.releaseReasonLease({
						actor,
						idempotencyKey: `reason-run:${runId}:release`,
						createdAt: this.now(),
						ownerId: lease.ownerId,
						generation: lease.generation,
						token: lease.token,
					});
				} catch {
					// Release is best-effort after expiry, completion, or revocation.
				}
			}
			this.activeChallenges.delete(challengeId);
		}
	}

	abortAll(): void {
		for (const controller of this.controllers) controller.abort();
	}

	private now(): string {
		const now = this.clock.now();
		if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
			throw new Error("Reasoner Clock returned invalid time");
		return now.toISOString();
	}

	private safeError(error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		return message
			.replace(/(?:token|cookie|api[-_ ]?key|authorization)\s*[:=]\s*\S+/gi, "credential:[redacted]")
			.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
			.slice(0, 240);
	}
}
