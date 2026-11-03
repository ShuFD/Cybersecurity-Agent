"""Read-only MiniMax quota checks; never treat an HTTP 200 as usable quota."""
import json
import math
import time
import urllib.error
import urllib.request

QUOTA_URL = 'https://www.minimaxi.com/v1/token_plan/remains'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def normalize_quota(body, expected_model):
    unknown = {'allowed': False, 'reason': 'quota_unknown'}
    if not isinstance(body, dict) or not isinstance(body.get('base_resp'), dict):
        return unknown
    code = body['base_resp'].get('status_code')
    if isinstance(code, bool) or code != 0:
        return {**unknown, 'reason': 'quota_api_rejected'}
    rows = body.get('model_remains')
    if not isinstance(rows, list):
        return unknown
    # The current Token Plan groups text models under 'general'. Never use
    # the unrelated video allowance, or silently select the first entry.
    exact = [r for r in rows if isinstance(r, dict) and r.get('model_name') == expected_model]
    selected = exact or [r for r in rows if isinstance(r, dict) and r.get('model_name') == 'general']
    if len(selected) != 1:
        return unknown
    row = selected[0]
    fields = ('current_interval_remaining_percent', 'current_weekly_remaining_percent')
    values = [row.get(k) for k in fields]
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 100 for v in values):
        return unknown
    report = {'allowed': min(values) > 0, 'reason': 'quota_positive' if min(values) > 0 else 'provider_quota_exhausted',
              'modelGroup': row['model_name'], **dict(zip(fields, values)),
              'sufficientForWholeQuestion': 'unknown'}
    # Zero *_total_count is normal in the new percentage-based response.
    # These counts do not mean there is no subscription.
    for key in ('start_time', 'end_time', 'weekly_start_time', 'weekly_end_time'):
        value = row.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
            report[key] = value
    return report


def query_quota(token, expected_model, *, opener=None, clock=time.time):
    req = urllib.request.Request(QUOTA_URL, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    result = {'checkedAt': clock(), 'allowed': False, 'reason': 'quota_unknown'}
    try:
        client = opener or urllib.request.build_opener(NoRedirect)
        with client.open(req, timeout=15) as response:
            raw = response.read(65537)
            result['httpStatus'] = response.status
            if response.status != 200 or len(raw) > 65536:
                return result
            result.update(normalize_quota(json.loads(raw), expected_model))
    except urllib.error.HTTPError as error:
        result['httpStatus'] = error.code
    except Exception as error:
        # Neither error text nor response bodies enter diagnostics.
        result['errorType'] = type(error).__name__
    return result
