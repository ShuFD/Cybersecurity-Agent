import { createHash } from "node:crypto";
import type { PiToolExecution } from "../subagent.ts";
import { type PlanningEvidenceInput, planningFlagCandidateHash } from "./contracts.ts";
import { captureEvidenceBlob, makeEvidenceExcerpt, makeEvidenceLocator } from "./evidence-store.ts";

function serializeEvidence(value: unknown): string {
	try {
		const result = JSON.stringify(value);
		return typeof result === "string" ? result : String(value);
	} catch {
		return String(value);
	}
}

export function captureToolEvidence(
	execution: PiToolExecution & { toolInput?: unknown },
	options: { stateDir: string; runId: string; leaseId: string; evidenceId?: string },
): PlanningEvidenceInput {
	const serialized = serializeEvidence(execution.result);
	const resultHash = createHash("sha256").update(serialized).digest("hex");
	const evidenceId =
		options.evidenceId ??
		"tool-" +
			createHash("sha256")
				.update(JSON.stringify([options.runId, options.leaseId, execution.toolCallId, execution.toolName]))
				.digest("hex")
				.slice(0, 24);
	const blob = captureEvidenceBlob({
		stateDir: options.stateDir,
		runId: options.runId,
		evidenceId,
		toolCallId: execution.toolCallId,
		toolName: execution.toolName,
		toolInput: execution.toolInput,
		result: execution.result,
		isError: execution.isError,
	});
	const excerpt = makeEvidenceExcerpt(execution.result, 4_096);
	const locator = makeEvidenceLocator(execution);
	const toolInput =
		typeof execution.toolInput === "object" && execution.toolInput !== null && !Array.isArray(execution.toolInput)
			? (execution.toolInput as Record<string, unknown>)
			: undefined;
	const candidate =
		toolInput && typeof (toolInput.flag ?? toolInput.candidate) === "string"
			? String(toolInput.flag ?? toolInput.candidate)
			: undefined;
	const result =
		typeof execution.result === "object" && execution.result !== null && !Array.isArray(execution.result)
			? (execution.result as Record<string, unknown>)
			: undefined;
	const details =
		result && typeof result.details === "object" && result.details !== null && !Array.isArray(result.details)
			? (result.details as Record<string, unknown>)
			: undefined;
	const data =
		details && typeof details.data === "object" && details.data !== null && !Array.isArray(details.data)
			? (details.data as Record<string, unknown>)
			: undefined;
	return {
		evidenceId,
		kind: "tool",
		source: execution.toolName,
		toolName: execution.toolName,
		summary: (execution.isError ? "error: " : "success: ") + execution.toolName,
		excerpt,
		contentRef: blob.contentRef,
		contentHash: blob.contentHash,
		excerptHash: createHash("sha256").update(excerpt).digest("hex"),
		contentBytes: blob.contentBytes,
		contentComplete: blob.contentComplete,
		isTruncated: !blob.contentComplete,
		locator,
		metadata: {
			toolCallId: execution.toolCallId,
			isError: execution.isError,
			evidenceId,
			resultHash,
			...(candidate && (execution.toolName === "verify_flag" || execution.toolName === "check_flag")
				? { candidateHash: planningFlagCandidateHash(candidate) }
				: {}),
			...(data && typeof data.status === "string" ? { verifierStatus: data.status } : {}),
			...(data && typeof data.verificationOutcome === "string"
				? { verificationOutcome: data.verificationOutcome }
				: {}),
			...(data && typeof data.failureCategory === "string" ? { failureCategory: data.failureCategory } : {}),
			...(data && typeof data.requestSent === "boolean" ? { requestSent: data.requestSent } : {}),
			...(typeof details?.remainingAttempts === "number"
				? { remainingAttempts: details.remainingAttempts }
				: typeof data?.remainingAttempts === "number"
					? { remainingAttempts: data.remainingAttempts }
					: {}),
		},
	};
}
