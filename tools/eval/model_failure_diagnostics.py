"""Post-run failure assessment; preserves raw results and never stops an agent."""
import json
import math
import re
from collections import Counter


def model_error_category(error):
    if not isinstance(error, str):
        return "unknown"
    match = re.fullmatch(r"429:\s*(\{.*\})", error, re.DOTALL)
    if match:
        try:
            body = json.loads(match.group(1))
        except (ValueError, TypeError):
            body = None
        if isinstance(body, dict) and body.get("type") == "rate_limit_error" and str(body.get("http_code")) == "429":
            message = body.get("message")
            if isinstance(message, str) and "已达到 Token Plan 用量上限" in message and "(2056)" in message:
                return "provider_quota_exhausted"
        return "rate_limit_or_unknown"
    if error == "terminated":
        return "transport_or_cancellation_unknown"
    return "unknown"


def summarize_model_failures(events, result):
    if events is None:
        return {"scope": "post_run_metadata_only", "status": "unknown", "rawTerminalReason": result.get("terminalReason"), "evaluationValidity": "unknown_missing_event_export", "performanceComparable": False}
    counts = Counter()
    quota_refs, waits, wait_ends = [], [], []
    model_errors = missing_error_details = 0
    for index, event in enumerate(events):
        if not isinstance(event, dict):
            continue
        kind, payload = event.get("type"), event.get("payload")
        if not isinstance(kind, str) or not isinstance(payload, dict):
            continue
        role = payload.get("role", "unknown")
        role = role if role in ("planner", "executor", "observer") else "unknown"
        ref = {"eventIndex": index, "eventId": event.get("eventId"), "role": role}
        if kind.endswith("model_service_wait"):
            reason = payload.get("reason", "unknown")
            waits.append({**ref, "reason": reason})
            # Host classification is retained even when legacy export removed
            # the original provider error. A generic HTTP 429 is insufficient.
            if reason == "provider_quota_exhausted" or model_error_category(payload.get("error")) == "provider_quota_exhausted":
                quota_refs.append({**ref, "origin": "quota_admission"})
        elif kind.endswith("model_service_wait_end"):
            duration = payload.get("waitElapsedMs")
            if isinstance(duration, (int, float)) and not isinstance(duration, bool) and math.isfinite(duration) and duration >= 0:
                wait_ends.append(duration)
        if not kind.endswith("assistant_message_end") or payload.get("stopReason") != "error":
            continue
        model_errors += 1
        if payload.get("errorCategory") not in ("provider_quota_exhausted", "rate_limit_or_unknown", "transport_reset", "authentication_or_permission") and (not isinstance(payload.get("error"), str) or not payload["error"].strip()):
            missing_error_details += 1
        category = model_error_category(payload.get("error"))
        if payload.get('errorCategory') in ('provider_quota_exhausted', 'rate_limit_or_unknown', 'transport_reset', 'authentication_or_permission', 'transport_or_cancellation_unknown'):
            category = payload['errorCategory']
        counts[(role, category)] += 1
        if category == "provider_quota_exhausted":
            quota_refs.append({**ref, "origin": "provider_error"})
    succeeded = result.get("terminalReason") == "verified_true" and result.get("verificationState") == "accepted"
    return {
        "scope": "post_run_metadata_only", "status": "recorded",
        "rawTerminalReason": result.get("terminalReason"),
        "modelErrorResponses": model_errors, "missingErrorDetails": missing_error_details,
        "categoriesByRole": [{"role": role, "category": category, "count": count} for (role, category), count in sorted(counts.items())],
        "providerQuotaExhausted": bool(quota_refs), "serviceWaits": waits,
        "serviceWaitEndedCount": len(wait_ends),
        "serviceWaitSecondsBySessionSum": sum(wait_ends) / 1000,
        "serviceWaitSumIsNotRunWallTime": True,
        "failureAssessment": "provider_quota_blocked" if quota_refs and not succeeded else "see_raw_outcome",
        "quotaEvidenceRefs": quota_refs,
        "evaluationValidity": "verified_success_with_provider_errors" if quota_refs and succeeded else "invalid_provider_quota" if quota_refs else "unknown_missing_error_details" if missing_error_details else "not_disqualified_by_provider_quota",
        "performanceComparable": not bool(quota_refs or missing_error_details),
        "zeroErrorsDoesNotProveHealthyTransport": True,
    }
