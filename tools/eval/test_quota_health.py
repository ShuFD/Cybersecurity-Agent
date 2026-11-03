import io
import json
import unittest
from quota_health import normalize_quota, query_quota, NoRedirect


def response(interval=54, weekly=36, name='general'):
    return {'base_resp': {'status_code': 0}, 'model_remains': [
        {'model_name': name, 'current_interval_total_count': 0, 'current_interval_usage_count': 0,
         'current_interval_remaining_percent': interval, 'current_weekly_remaining_percent': weekly,
         'end_time': 1792116000000},
        {'model_name': 'video', 'current_interval_remaining_percent': 100, 'current_weekly_remaining_percent': 100}]}


class QuotaTests(unittest.TestCase):
    def test_structured_diagnostic_survives_export_without_original_body(self):
        from model_failure_diagnostics import summarize_model_failures
        events = [{'type': 'cairn_executor_assistant_message_end', 'eventId': 'native-model-error',
                   'payload': {'role': 'executor', 'stopReason': 'error', 'errorCategory': 'provider_quota_exhausted', 'providerStatus': 429}}]
        report = summarize_model_failures(events, {'terminalReason': 'wall_clock_timeout'})
        self.assertTrue(report['providerQuotaExhausted'])
        self.assertEqual(report['missingErrorDetails'], 0)
        self.assertEqual(report['quotaEvidenceRefs'][0]['eventId'], 'native-model-error')

    def test_unknown_structured_error_remains_unknown(self):
        from model_failure_diagnostics import summarize_model_failures
        report = summarize_model_failures([{'type': 'assistant_message_end', 'payload': {
            'stopReason': 'error', 'errorCategory': 'unknown'}}], {'terminalReason': 'wall_clock_timeout'})
        self.assertEqual(report['missingErrorDetails'], 1)
        self.assertFalse(report['performanceComparable'])

    def test_current_live_schema_zero_counts_use_percentages(self):
        actual = normalize_quota(response(), 'MiniMax-M3')
        self.assertTrue(actual['allowed'])
        self.assertEqual(actual['current_weekly_remaining_percent'], 36)
        self.assertEqual(actual['sufficientForWholeQuestion'], 'unknown')

    def test_either_window_exhausted_blocks_even_if_video_full(self):
        for a, b in [(0, 100), (100, 0), (0, 0)]:
            self.assertEqual(normalize_quota(response(a, b), 'MiniMax-M3')['reason'], 'provider_quota_exhausted')

    def test_unknown_or_malformed_does_not_admit(self):
        for body in [None, {}, {'base_resp': {'status_code': 1}}, response(None, 4), response(True, 4),
                     response(float('nan'), 4), response(-1, 4), response(101, 4), response(40, '50')]:
            self.assertFalse(normalize_quota(body, 'MiniMax-M3')['allowed'])

    def test_no_general_does_not_use_video(self):
        self.assertFalse(normalize_quota(response(name='other-text-model'), 'MiniMax-M3')['allowed'])

    def test_explicit_model_beats_general(self):
        body = response()
        body['model_remains'].append({'model_name': 'MiniMax-M3', 'current_interval_remaining_percent': 0, 'current_weekly_remaining_percent': 50})
        self.assertFalse(normalize_quota(body, 'MiniMax-M3')['allowed'])

    def test_duplicate_model_is_unknown(self):
        body = response(); body['model_remains'].append(body['model_remains'][0])
        self.assertFalse(normalize_quota(body, 'MiniMax-M3')['allowed'])

    def test_http200_business_error_is_not_healthy(self):
        class Opener:
            def open(self, req, timeout):
                value = io.BytesIO(json.dumps({'base_resp': {'status_code': 1004, 'status_msg': 'secret'}}).encode())
                value.status = 200
                return value
        actual = query_quota('test-secret', 'MiniMax-M3', opener=Opener(), clock=lambda: 123)
        self.assertFalse(actual['allowed'])
        self.assertNotIn('secret', json.dumps(actual))

    def test_errors_and_redirect_do_not_leak_credentials(self):
        class Opener:
            def open(self, req, timeout):
                raise OSError('Bearer test-secret')
        actual = query_quota('test-secret', 'MiniMax-M3', opener=Opener())
        self.assertFalse(actual['allowed'])
        self.assertNotIn('secret', json.dumps(actual))
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.invalid'))


if __name__ == '__main__': unittest.main()
