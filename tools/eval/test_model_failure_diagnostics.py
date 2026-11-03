import unittest
from model_failure_diagnostics import model_error_category, summarize_model_failures

QUOTA = '429: {"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)","http_code":"429"}'

class ModelFailureTests(unittest.TestCase):
    def test_blank_error_export_is_unknown_not_a_clean_performance_sample(self):
        for error in (None, "", "   "):
            report = summarize_model_failures([{"type":"cairn_assistant_message_end", "payload":{"stopReason":"error", "role":"executor", "error":error}}], {"terminalReason":"max_turns"})
            self.assertEqual(report["evaluationValidity"], "unknown_missing_error_details")
            self.assertEqual(report["missingErrorDetails"], 1)
            self.assertFalse(report["performanceComparable"])

    def test_missing_export_unknown(self):
        report=summarize_model_failures(None,{"terminalReason":"max_turns"})
        self.assertEqual(report["status"],"unknown")
        self.assertFalse(report["performanceComparable"])
    def test_exact_provider_quota(self):
        self.assertEqual(model_error_category(QUOTA), "provider_quota_exhausted")
    def test_transient_429_is_not_quota(self):
        self.assertEqual(model_error_category('429: {"type":"rate_limit_error","message":"too many requests","http_code":"429"}'), "rate_limit_or_unknown")
    def test_2056_alone_not_quota(self):
        self.assertNotEqual(model_error_category('429: {"type":"rate_limit_error","message":"2056","http_code":"429"}'), "provider_quota_exhausted")
    def test_wrong_shape_not_quota(self):
        for value in (None, '429: []', '429: broken', QUOTA.replace('rate_limit_error','other'), QUOTA.replace('"429"','"400"')):
            self.assertNotEqual(model_error_category(value), "provider_quota_exhausted")
    def test_only_provider_error_events_count(self):
        events=[{"type":"tool_execution_end","payload":{"error":QUOTA,"stopReason":"error"}}, {"type":"assistant_message_end","payload":{"error":QUOTA,"stopReason":"toolUse"}}]
        self.assertFalse(summarize_model_failures(events,{})["providerQuotaExhausted"])
    def test_two_role_adapters_raw_outcome_immutable(self):
        events=[{"eventId":"p", "type":"assistant_message_end","payload":{"error":QUOTA,"stopReason":"error","role":"planner"}}, {"eventId":"e", "type":"cairn_assistant_message_end","payload":{"error":QUOTA,"stopReason":"error","role":"executor"}}]
        result={"terminalReason":"max_turns","verificationState":"not_attempted"}
        report=summarize_model_failures(events,result)
        self.assertEqual(report["evaluationValidity"],"invalid_provider_quota")
        self.assertEqual(result["terminalReason"],"max_turns")
        self.assertEqual(len(report["quotaEvidenceRefs"]),2)
    def test_verified_success_preserved_not_performance_comparable(self):
        report=summarize_model_failures([{"type":"assistant_message_end","payload":{"error":QUOTA,"stopReason":"error"}}],{"terminalReason":"verified_true","verificationState":"accepted"})
        self.assertEqual(report["evaluationValidity"],"verified_success_with_provider_errors")
        self.assertFalse(report["performanceComparable"])
    def test_terminated_layer_unknown(self):
        self.assertEqual(model_error_category("terminated"),"transport_or_cancellation_unknown")

if __name__ == "__main__":
    unittest.main()
