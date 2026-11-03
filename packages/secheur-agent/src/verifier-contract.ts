export type NativeFlagVerifierToolName = "verify_flag" | "check_flag";

export interface AcceptedNativeFlagVerification {
	toolName: NativeFlagVerifierToolName;
	verificationOutcome: "correct";
	challengeId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The shared success gate for native verifier tool results. Callers must also
 * establish the result's runtime provenance and bind it to the current task.
 */
export function acceptedNativeFlagVerification(
	toolName: unknown,
	isError: unknown,
	result: unknown,
): AcceptedNativeFlagVerification | undefined {
	if ((toolName !== "verify_flag" && toolName !== "check_flag") || isError !== false || !isRecord(result)) {
		return undefined;
	}
	const details = isRecord(result.details) ? result.details : undefined;
	const data = details && isRecord(details.data) ? details.data : undefined;
	if (!data || data.ok !== true || data.verified !== true || data.status !== "correct") return undefined;
	return {
		toolName,
		verificationOutcome: "correct",
		...(typeof data.challenge_id === "string" && data.challenge_id.trim()
			? { challengeId: data.challenge_id.trim() }
			: {}),
	};
}
