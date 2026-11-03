import { acceptedNativeFlagVerification } from "../verifier-contract.ts";
import type { PlanningEvidence, PlanningSnapshot, TrustedPlanningVerification } from "./contracts.ts";

function acceptedEvidenceVerification(
	evidence: PlanningEvidence,
	snapshot: PlanningSnapshot,
): TrustedPlanningVerification | undefined {
	if (evidence.kind !== "tool" || evidence.runId !== snapshot.run.runId) return undefined;
	if (!evidence.taskId || !evidence.leaseId || !evidence.evidenceId) return undefined;
	if (!snapshot.tasks.some((task) => task.runId === snapshot.run.runId && task.taskId === evidence.taskId)) {
		return undefined;
	}
	if (evidence.source !== evidence.toolName) return undefined;
	if (evidence.metadata.isError !== false) return undefined;
	if (typeof evidence.metadata.toolCallId !== "string" || evidence.metadata.toolCallId.trim().length === 0) {
		return undefined;
	}
	if (evidence.metadata.evidenceId !== evidence.evidenceId || evidence.isTruncated || !evidence.contentComplete) {
		return undefined;
	}
	let result: unknown;
	try {
		result = JSON.parse(evidence.excerpt);
	} catch {
		return undefined;
	}
	const accepted = acceptedNativeFlagVerification(evidence.toolName, evidence.metadata.isError, result);
	if (!accepted || evidence.metadata.verificationOutcome !== accepted.verificationOutcome) return undefined;
	return {
		source: "planning_verifier_evidence",
		verificationOutcome: accepted.verificationOutcome,
		planningRunId: snapshot.run.runId,
		taskId: evidence.taskId,
		leaseId: evidence.leaseId,
		evidenceId: evidence.evidenceId,
		evidenceCreatedAt: evidence.createdAt,
		...(accepted.challengeId ? { challengeId: accepted.challengeId } : {}),
	};
}

export function trustedPlanningVerificationFromSnapshot(
	snapshot: PlanningSnapshot,
): TrustedPlanningVerification | undefined {
	for (const evidence of snapshot.evidence) {
		const accepted = acceptedEvidenceVerification(evidence, snapshot);
		if (accepted) return accepted;
	}
	return undefined;
}
