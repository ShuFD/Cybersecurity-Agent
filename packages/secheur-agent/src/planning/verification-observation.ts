import { acceptedNativeFlagVerification } from "../verifier-contract.ts";

/** Diagnostic only: never grants authority to a model report or changes termination. */
export function nativeVerificationObservation(toolName: string, result: unknown, isError: boolean):
	{ status: "accepted" | "rejected" | "blocked" | "error"; requestSent: boolean; failureCategory?: string } | undefined {
	if (!["verify_flag", "check_flag"].includes(toolName) || !result || typeof result !== "object") return undefined;
	const details = (result as { details?: { data?: Record<string, unknown> } }).details;
	const data = details?.data;
	if (!data) return undefined;
	if (data.requestSent === false) return { status: "blocked", requestSent: false };
	if (acceptedNativeFlagVerification(toolName, isError, result)) return { status: "accepted", requestSent: true };
	if (data.verified === false && data.status === "incorrect") return { status: "rejected", requestSent: true };
	if (data.verificationOutcome === "incorrect") return { status: "rejected", requestSent: true };
	if (isError && data.requestSent === true) return { status: "error", requestSent: true, ...(typeof data.failureCategory === "string" ? { failureCategory: data.failureCategory } : {}) };
	return undefined;
}
