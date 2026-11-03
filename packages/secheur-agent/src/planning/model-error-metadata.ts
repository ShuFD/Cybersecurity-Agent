import { isTokenPlanQuotaExhausted } from "@earendil-works/pi-ai";

/** Only classification is exported; provider bodies and credentials stay private. */
export function modelErrorMetadata(error: unknown): Record<string, string | number | boolean> {
	if (typeof error !== "string" || !error.trim()) return {};
	const result: Record<string, string | number | boolean> = {};
	const status = /^(4\d\d|5\d\d):(?:\s|$)/u.exec(error);
	if (status) result.providerStatus = Number(status[1]);
	if (isTokenPlanQuotaExhausted(error)) {
		return { ...result, errorCategory: "provider_quota_exhausted", quotaExhausted: true };
	}
	if (result.providerStatus === 400 || result.providerStatus === 422)
		return { ...result, errorCategory: "invalid_request" };
	if (/\bECONNRESET\b/u.test(error))
		return { ...result, errorCategory: "transport_reset", transportCode: "ECONNRESET" };
	if (result.providerStatus === 429) return { ...result, errorCategory: "rate_limit_or_unknown" };
	if (result.providerStatus === 401 || result.providerStatus === 403)
		return { ...result, errorCategory: "authentication_or_permission" };
	return { ...result, errorCategory: error === "terminated" ? "transport_or_cancellation_unknown" : "unknown" };
}
