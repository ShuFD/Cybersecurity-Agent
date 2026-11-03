/** Export orchestration metadata only; Graph content/raw results stay in their stores. */
export function sanitizeCairnTracePayload(payload: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of [
		"role",
		"origin",
		"requestId",
		"errorStage",
		"errorCategory",
		"transportCode",
		"providerStatus",
		"quotaExhausted",
		"protocolRecovery",
		"waitElapsedMs",
		"delayMs",
		"reviewTurns",
		"cacheHit",
		"requestSent",
		"verificationHistoryCount",
		"feedbackActive",
		"startedAt",
		"endedAt",
		"offset",
		"nextOffset",
		"totalBytes",
		"returnedBytes",
		"provider",
		"model",
		"reason",
		"stopReason",
		"inputTokens",
		"outputTokens",
		"contextWindow",
		"outputChars",
		"cost",
		"modelTurns",
		"allowance",
		"engine",
		"runId",
		"taskId",
		"leaseId",
		"solverId",
		"evidenceId",
		"toolCallId",
		"toolName",
		"status",
		"failureCode",
		"attempt",
		"attempts",
		"attemptsUsed",
		"category",
		"recovered",
		"accepted",
		"available",
		"modelCalled",
		"assignmentCount",
		"activeCount",
		"capacity",
		"elapsedMs",
		"durable",
		"partial",
		"isError",
		"settled",
	]) {
		const value = payload[key];
		if (
			(typeof value === "string" && value.length <= 160) ||
			(typeof value === "number" && Number.isFinite(value)) ||
			typeof value === "boolean"
		)
			result[key] = value;
	}
	return result;
}
