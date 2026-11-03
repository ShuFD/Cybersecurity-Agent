"""HTTP status code classification and agent-friendly error formatting.

Used by web_fetch, crawlers, and any tool that makes HTTP requests, so the Agent
gets actionable guidance instead of a bare status code.
"""

from __future__ import annotations

import time
from typing import Callable

# ── retryable server-side status codes ──────────────────────────────────────
_RETRYABLE = frozenset({
    408,  # Request Timeout
    409,  # Conflict
    425,  # Too Early
    429,  # Too Many Requests
    500,  # Internal Server Error
    502,  # Bad Gateway
    503,  # Service Unavailable
    504,  # Gateway Timeout
    *range(520, 530),  # Cloudflare / reverse-proxy codes
})

# Maximum retries for 5xx in web_fetch (conservative — only 3)
_WEB_FETCH_MAX_RETRIES = 3
_WEB_FETCH_RETRY_DELAY_BASE = 1.0  # seconds


def is_retryable(code: int) -> bool:
    """True when the status code is worth retrying (server-side / rate-limit)."""
    return code in _RETRYABLE


def is_server_error(code: int) -> bool:
    return 500 <= int(code) < 600


def is_client_error(code: int) -> bool:
    return 400 <= int(code) < 500


# ── agent-facing error hints ───────────────────────────────────────────────

def _client_error_hint(code: int) -> str:
    hints: dict[int, str] = {
        400: "Bad Request — the request was malformed. Check the URL and parameters.",
        401: "Unauthorized — authentication is required for this resource.",
        403: "Forbidden — the server refuses to serve this resource. "
             "This may be intentional access control, geo-blocking, or an auth wall.",
        404: "Not Found — the resource does not exist at this URL. "
             "If you were enumerating paths or probing for endpoints, this confirms absence. "
             "If you expected content here, double-check the URL.",
        405: "Method Not Allowed — the HTTP method is not supported for this endpoint.",
        408: "Request Timeout — the server timed out waiting for the request.",
        409: "Conflict — the request conflicts with the current server state.",
        410: "Gone — the resource existed before but has been permanently removed.",
        429: "Too Many Requests — you are being rate-limited. Slow down and retry later.",
        451: "Unavailable For Legal Reasons — the content is legally blocked.",
    }
    if code in hints:
        return hints[code]
    return f"HTTP {code} — client error. The request may be malformed or the resource may not be accessible."


def _server_error_hint(code: int) -> str:
    hints: dict[int, str] = {
        500: "Internal Server Error — the target server is malfunctioning. "
             "The request may be valid but the server cannot process it right now. "
             "Consider waiting and retrying, or trying a different endpoint.",
        501: "Not Implemented — the server does not support this functionality.",
        502: "Bad Gateway — an upstream server returned an invalid response. "
             "This is usually temporary; retry with backoff.",
        503: "Service Unavailable — the server is temporarily down or overloaded. "
             "Retry with backoff after a short wait.",
        504: "Gateway Timeout — an upstream server did not respond in time. "
             "The request may succeed on retry.",
    }
    if code in hints:
        return hints[code]
    return f"HTTP {code} — server error. The remote service has an issue that may be temporary."


def format_http_error(code: int, reason: str = "", *, url: str = "") -> str:
    """Return an agent-friendly, one-line error string for an HTTP status code."""
    reason_part = f" {reason}" if reason else ""
    if is_client_error(code):
        hint = _client_error_hint(code)
    elif is_server_error(code):
        hint = _server_error_hint(code)
    else:
        hint = f"HTTP {code}{reason_part} — unexpected status."

    if url:
        return f"HTTP {code}{reason_part}: {hint} (URL: {url})"
    return f"HTTP {code}{reason_part}: {hint}"


def classify_for_agent(code: int, url: str = "") -> dict:
    """Return a structured classification dict the Agent can reason about.

    The 'category' field helps the Agent decide its next action:
      - 'not_found'        → resource confirmed absent (enumeration result)
      - 'auth_required'    → needs credentials / login
      - 'access_denied'    → server-level block (IP, geo, WAF)
      - 'rate_limited'     → back off and retry
      - 'server_error'     → retryable server fault
      - 'client_error'     → request problem (check URL / params)
      - 'unknown'          → unclassifiable
    """
    _code = int(code)
    if is_server_error(_code):
        return {
            "category": "server_error",
            "retryable": True,
            "meaning": "The remote server is experiencing an error. The request may be correct but the service is down or overloaded.",
            "suggestion": "Wait a few seconds and retry, or try a different endpoint on the same host.",
        }
    if _code == 429:
        return {
            "category": "rate_limited",
            "retryable": True,
            "meaning": "The server is rate-limiting requests.",
            "suggestion": "Wait at least 5-10 seconds before retrying.",
        }
    if _code in (401,):
        return {
            "category": "auth_required",
            "retryable": False,
            "meaning": "This endpoint requires authentication.",
            "suggestion": "Try to obtain credentials or check if there is an unauthenticated alternative.",
        }
    if _code in (403, 451):
        return {
            "category": "access_denied",
            "retryable": False,
            "meaning": "The server is blocking access (IP block, geo-restriction, WAF, or legal restriction).",
            "suggestion": "Try a different URL or source. Do NOT retry the same URL repeatedly.",
        }
    if _code == 404:
        return {
            "category": "not_found",
            "retryable": False,
            "meaning": "The resource does not exist. If you were probing or enumerating, this is a valid negative result.",
            "suggestion": "Do NOT retry this URL. If this was an enumeration, record the result and move on.",
        }
    if _code == 410:
        return {
            "category": "not_found",
            "retryable": False,
            "meaning": "The resource existed before but has been permanently removed.",
            "suggestion": "Do NOT retry. Look for an archived copy or alternative source.",
        }
    if is_client_error(_code):
        return {
            "category": "client_error",
            "retryable": False,
            "meaning": f"The request was rejected by the server (status {_code}).",
            "suggestion": "Check the URL format and request parameters. Do NOT blindly retry.",
        }
    return {
        "category": "unknown",
        "retryable": False,
        "meaning": f"Unexpected HTTP status {_code}.",
        "suggestion": "Log this for investigation.",
    }


# ── retry loop for web_fetch (simple, not stream-aware) ────────────────────

def retry_web_fetch(
    fetch_fn: Callable[[], tuple[int, str, str]],
    *,
    max_retries: int = _WEB_FETCH_MAX_RETRIES,
    base_delay: float = _WEB_FETCH_RETRY_DELAY_BASE,
    jitter_fn: Callable[[], float] | None = None,
) -> tuple[int, str, str]:
    """Call *fetch_fn* repeatedly for retryable status codes.

    Returns (status_code, content_type, body_text) on success or after exhausting retries.
    """
    import random as _random

    _jitter = jitter_fn or _random.random
    last_result: tuple[int, str, str] = (0, "", "")
    for attempt in range(max_retries + 1):
        status, ct, body = fetch_fn()
        last_result = (status, ct, body)
        if status < 400:
            return last_result
        if not is_retryable(status) or attempt >= max_retries:
            return last_result
        delay = min(30.0, base_delay * (2 ** attempt))
        delay *= 0.8 + _jitter() * 0.4
        time.sleep(max(0.5, delay))
    return last_result
