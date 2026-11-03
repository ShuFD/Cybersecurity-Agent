import asyncio
import concurrent.futures
import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

from credential_admission import AdmittedQueue, CredentialAdmission
from model_failure_diagnostics import summarize_model_failures
from six_key_pool import SixKeyPool

ROOT = Path(__file__).parent
RELEASE = str(ROOT.parent.parent)
CONFIRMED = {'providerQuotaExhausted': True, 'quotaEvidenceRefs': [{'eventId': 'wait-1', 'origin': 'quota_admission'}]}


def entries():
    return [{'token': f'test-only-credential-{i}', 'baseUrl': 'https://api.minimaxi.com/v1', 'model': 'MiniMax-M3'} for i in range(6)]


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'state.sqlite'
        self.pool = SixKeyPool(entries(), 'MiniMax-M3', self.path)

    def tearDown(self):
        self.temp.cleanup()

    def test_recorded_slot_sequences_block_later_targets(self):
        # Exact metadata from Cairn host.lifecycle, with error text intentionally
        # absent just as in the original public export.
        for fixture in json.loads((ROOT / 'quota-replay-fixture.json').read_text()):
            slot = fixture['slot'] - 1
            diagnostics = summarize_model_failures(fixture['events'], {'terminalReason': 'wall_clock_timeout'})
            self.assertTrue(diagnostics['providerQuotaExhausted'])
            self.assertEqual(diagnostics['rawTerminalReason'], 'wall_clock_timeout')
            allowed = self.pool.check_admission(slot)['allowed']
            self.assertEqual(allowed, fixture['expectedAdmission'])
            if allowed:
                self.pool.finish(slot, fixture['runId'], {'modelFailureDiagnostics': diagnostics})
        self.assertTrue(self.pool.check_admission(1)['allowed'])
        self.assertTrue(self.pool.check_admission(2)['allowed'])

    def test_transient_429_does_not_block(self):
        event = {'type': 'assistant_message_end', 'payload': {'role': 'executor', 'stopReason': 'error', 'error': '429: {"type":"rate_limit_error","message":"retry later","http_code":"429"}'}}
        diag = summarize_model_failures([event], {'terminalReason': 'wall_clock_timeout'})
        self.assertFalse(diag['providerQuotaExhausted'])
        self.pool.finish(0, 'transient', {'modelFailureDiagnostics': diag})
        self.assertTrue(self.pool.check_admission(0)['allowed'])

    def test_claim_without_evidence_cannot_disable(self):
        self.pool.finish(0, 'no-evidence', {'modelFailureDiagnostics': {'providerQuotaExhausted': True}})
        self.assertTrue(self.pool.check_admission(0)['allowed'])

    def test_durable_fingerprint_isolated_across_slot_reorder(self):
        self.pool.finish(0, 'quota', {'modelFailureDiagnostics': CONFIRMED})
        restored = SixKeyPool(list(reversed(entries())), 'MiniMax-M3', self.path)
        self.assertFalse(restored.check_admission(5)['allowed'])
        self.assertTrue(restored.check_admission(0)['allowed'])

    def test_all_exhausted_queue_preserves_pending(self):
        for slot in range(6):
            self.pool.finish(slot, f'quota-{slot}', {'modelFailureDiagnostics': CONFIRMED})
        queue = asyncio.Queue()
        queue.put_nowait(('still-pending', False))
        for slot in range(6):
            admitted = AdmittedQueue(queue, lambda slot=slot: self.pool.check_admission(slot)['allowed'])
            self.assertTrue(admitted.empty())
            with self.assertRaises(asyncio.QueueEmpty):
                admitted.get_nowait()
        self.assertEqual(queue.qsize(), 1)

    def test_duplicate_finish_and_explicit_recovery(self):
        result = {'modelFailureDiagnostics': CONFIRMED}
        self.pool.finish(0, 'quota', result)
        self.pool.finish(0, 'quota', result)
        self.assertFalse(self.pool.check_admission(0)['allowed'])
        with self.assertRaises(ValueError):
            self.pool.recover_after_successful_probe(0, status=429, probe_ref='probe-failed')
        self.pool.recover_after_successful_probe(0, status=200, probe_ref='probe-success-credential-0')
        self.pool.finish(0, 'quota', result)
        self.assertTrue(self.pool.check_admission(0)['allowed'])
        self.pool.finish(0, 'new-quota', result)
        self.assertFalse(self.pool.check_admission(0)['allowed'])

    def test_run_cannot_change_credential(self):
        self.pool.finish(0, 'quota', {'modelFailureDiagnostics': CONFIRMED})
        with self.assertRaises(ValueError):
            self.pool.finish(1, 'quota', {'modelFailureDiagnostics': CONFIRMED})

    def test_concurrent_finishes_preserve_all_credential_blocks(self):
        def finish(slot):
            pool = SixKeyPool(entries(), 'MiniMax-M3', self.path)
            return pool.finish(slot, f'run-{slot}', {'modelFailureDiagnostics': CONFIRMED})
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as workers:
            outcomes = list(workers.map(finish, range(6)))
        self.assertTrue(all(not row['allowed'] for row in outcomes))
        self.assertTrue(all(not self.pool.check_admission(slot)['allowed'] for slot in range(6)))

    def test_diagnostics_missing_error_preserves_host_quota_reason(self):
        events = [{'type': 'assistant_message_end', 'payload': {'stopReason': 'error', 'role': 'planner'}},
                  {'type': 'model_service_wait', 'eventId': 'host-event', 'payload': {'reason': 'provider_quota_exhausted'}}]
        result = {'terminalReason': 'wall_clock_timeout'}
        diag = summarize_model_failures(events, result)
        self.assertTrue(diag['providerQuotaExhausted'])
        self.assertEqual(diag['quotaEvidenceRefs'][0]['eventId'], 'host-event')
        self.assertEqual(diag['evaluationValidity'], 'invalid_provider_quota')
        self.assertEqual(result, {'terminalReason': 'wall_clock_timeout'})

    def test_diagnostics_robust_missing_payload_and_wait_end(self):
        events = [None, {}, {'type': 'model_service_wait', 'payload': None},
                  {'type': 'model_service_wait_end', 'payload': {'waitElapsedMs': 'not-number'}},
                  {'type': 'model_service_wait_end', 'payload': {'waitElapsedMs': 1000}}]
        diag = summarize_model_failures(events, {'terminalReason': 'wall_clock_timeout'})
        self.assertEqual(diag['serviceWaitEndedCount'], 1)
        self.assertEqual(diag['serviceWaitSecondsBySessionSum'], 1)
        self.assertFalse(diag['providerQuotaExhausted'])


class FakeState:
    def __init__(self):
        self.reservations = []
        self.finishes = []

    def load(self):
        pass

    def running_targets(self):
        return set()

    def terminal_targets(self):
        return {target for target, _reason in self.finishes}

    def next_profile(self, lane):
        return 1, 0

    def profile_cooldown_remaining(self, profile):
        return 0

    async def reserve(self, lane, target_id, profile, ordinal, run_id, **kwargs):
        self.reservations.append((lane.index, target_id))

    async def finish(self, target_id, result):
        self.finishes.append((target_id, result['terminalReason']))


class ControllerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        config_path = Path(self.temp.name) / 'config.json'
        config_path.write_text(json.dumps({'release': RELEASE}))
        saved_argv = sys.argv
        try:
            sys.argv = ['test', '--config', str(config_path)]
            self.module = importlib.import_module('six_key_eval_controller')
        finally:
            sys.argv = saved_argv

    async def asyncTearDown(self):
        self.temp.cleanup()

    def controller(self, lane_count, hard_quota_slots):
        outer = self

        class ReplayController(self.module.SixKeyEvaluationController):
            async def _refresh_quota(self, slot):
                self._quota_health[slot] = getattr(self, "quota_response", {"allowed": True, "reason": "quota_positive"})

            async def preflight(self):
                return {1}

            async def _candidate_rows(self, target_ids):
                return [{'target_id': name, 'status': 'untested'} for name in ['a', 'b', 'c', 'd']]

            async def _run_one(self, lane, target_id, profile, run_id):
                # Deliberately overlap owners. No cancellation branch exists.
                await asyncio.sleep(0.005 if lane.index == 0 else 0.02)
                diag = CONFIRMED if lane.index in hard_quota_slots else {}
                result = {'terminalReason': 'wall_clock_timeout' if diag else 'verified_true', 'modelFailureDiagnostics': diag}
                self.key_pool.finish(self._lane_slots[lane.index], run_id, result)
                return result

        controller = object.__new__(ReplayController)
        controller.config = types.SimpleNamespace(
            state_root=Path(self.temp.name) / 'controller', poll_seconds=0.01,
            lanes=tuple(self.module.frozen.base.Lane(i, (1,)) for i in range(lane_count)))
        controller.state = FakeState()
        controller.allow_done_rerun = False
        controller._cleanup_diagnostics = {}
        controller._lane_slots = dict(enumerate(range(lane_count)))
        controller._pending_queue = None
        controller._quota_health = {}
        controller.key_pool = SixKeyPool(entries(), 'MiniMax-M3', Path(self.temp.name) / 'controller.sqlite')
        return controller

    async def test_quota_api_unknown_keeps_targets_pending_without_infra_result(self):
        controller = self.controller(2, set())
        controller.quota_response = {'allowed': False, 'reason': 'quota_unknown'}
        self.assertEqual(await controller.execute(None, 4), [])
        self.assertEqual(controller.state.reservations, [])
        status = json.loads((controller.config.state_root / 'credential-admission-status.json').read_text())
        self.assertEqual(len(status['pending']), 4)
        self.assertFalse(status['inFlightCancelled'])

    async def test_zero_real_quota_keeps_targets_pending(self):
        controller = self.controller(2, set())
        controller.quota_response = {'allowed': False, 'reason': 'provider_quota_exhausted'}
        self.assertEqual(await controller.execute(None, 4), [])
        self.assertEqual(controller.state.reservations, [])

    async def test_refresh_uses_thread_and_persists_sanitized_status(self):
        from unittest.mock import patch
        controller = self.controller(1, set())
        with patch.object(self.module, 'query_quota', return_value={'allowed': False, 'reason': 'quota_unknown'}) as query:
            await self.module.SixKeyEvaluationController._refresh_quota(controller, 0)
            query.assert_called_once()
        self.assertFalse(controller._quota_health[0]['allowed'])
        saved = json.loads((controller.config.state_root / 'quota-health/slot-1.json').read_text())
        self.assertEqual(saved['reason'], 'quota_unknown')
        self.assertNotIn('test-only-credential', json.dumps(saved))

    async def test_other_lane_continues_after_quota_owner_finishes(self):
        controller = self.controller(2, {0})
        results = await controller.execute(None, 4)
        self.assertEqual(len(results), 4)
        self.assertEqual([t for lane, t in controller.state.reservations if lane == 0], ['a'])
        self.assertEqual([t for lane, t in controller.state.reservations if lane == 1], ['b', 'c', 'd'])
        self.assertFalse(any(row['terminalReason'] == 'infra_failed' for row in results))
        status = json.loads((controller.config.state_root / 'credential-admission-status.json').read_text())
        self.assertEqual(status['status'], 'complete')

    async def test_all_exhausted_finish_current_owners_leave_remaining_pending(self):
        controller = self.controller(2, {0, 1})
        results = await controller.execute(None, 4)
        self.assertEqual(len(results), 2)
        self.assertEqual(len(controller.state.finishes), 2)
        status = json.loads((controller.config.state_root / 'credential-admission-status.json').read_text())
        self.assertEqual(status['status'], 'pending_credentials')
        self.assertEqual([row['targetId'] for row in status['pending']], ['c', 'd'])
        self.assertFalse(any(row['terminalReason'] == 'infra_failed' for row in results))

    async def test_restart_keeps_pending_until_specific_credential_recovers(self):
        first = self.controller(2, {0, 1})
        await first.execute(None, 4)
        restored = self.controller(2, set())
        restored.state = first.state
        self.assertEqual(await restored.execute(None, 4), [])
        self.assertEqual(len(restored.state.reservations), 2)
        restored.key_pool.recover_after_successful_probe(1, status=200, probe_ref='restart-slot-2-ok')
        results = await restored.execute(None, 4)
        self.assertEqual(len(results), 2)
        self.assertEqual(restored.state.reservations, [(0, 'a'), (1, 'b'), (1, 'c'), (1, 'd')])
        status = json.loads((restored.config.state_root / 'credential-admission-status.json').read_text())
        self.assertEqual(status['status'], 'complete')


if __name__ == '__main__':
    unittest.main(verbosity=2)
