"""Reuse the frozen evaluation harness with a separate key for each of six lanes."""
import asyncio
import json
import sys
from pathlib import Path

from six_key_pool import SixKeyPool
from credential_admission import AdmittedQueue
from quota_health import query_quota

# The base release is explicit, frozen and untouched. Only host-side routing changes.
parser_release = None
for index, value in enumerate(sys.argv):
    if value == '--config' and index + 1 < len(sys.argv):
        parser_release = json.loads(Path(sys.argv[index + 1]).read_text())['release']
if parser_release is None:
    raise SystemExit('An explicit --config is required')
sys.path.insert(0, str(Path(parser_release) / 'tools/eval'))
sys.path.append(str(Path(__file__).resolve().parent))
import sandbox_eval_controller as frozen


class SixKeyEvaluationController(frozen.SandboxEvaluationController):
    def __init__(self, config, field, state, settings, *, allow_done_rerun=False):
        super().__init__(config, field, state, settings, allow_done_rerun=allow_done_rerun)
        lane_count = config.resolved_controller_concurrency()
        if not 1 <= lane_count <= 6 or len(config.lanes) != lane_count or {lane.index for lane in config.lanes} != set(range(lane_count)):
            raise ValueError('Credential evaluation requires one to six sequential lanes')
        pool_config = dict(settings['sixKeyPool'])
        pool_config.setdefault('admissionState', str(config.state_root / 'credential-admission.sqlite'))
        self.key_pool = SixKeyPool.from_configuration(pool_config, settings['model']['model'])
        slots = pool_config.get('laneSlots', list(range(lane_count)))
        if len(slots) != lane_count or len(set(slots)) != lane_count or any(isinstance(slot, bool) or not isinstance(slot, int) or not 0 <= slot < 6 for slot in slots):
            raise ValueError('Each evaluation lane requires a distinct valid credential slot')
        self._lane_slots = dict(enumerate(slots))
        for slot in slots:
            self.key_pool.settings_for_slot(settings, slot)
        self._pending_queue = None
        self._busy_slots = set()
        self._quota_health = {}

    async def _run_lane(self, lane, queue):
        self._pending_queue = queue
        slot = self._lane_slots[lane.index]
        await self._refresh_quota(slot)
        admitted = AdmittedQueue(queue, lambda: self.key_pool.check_admission(slot)['allowed'] and self._quota_health.get(slot, {}).get('allowed') is True)
        return await super()._run_lane(lane, admitted)

    async def _refresh_quota(self, slot):
        entry = self.key_pool._entries[slot]
        health = await asyncio.to_thread(query_quota, entry['token'], entry['model'])
        self._quota_health[slot] = health
        directory = self.config.state_root / 'quota-health'
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / ('slot-' + str(slot + 1) + '.json')
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps({**self.key_pool.metadata_for_slot(slot), **health}))
        temporary.chmod(0o600)
        temporary.replace(path)

    async def execute(self, target_ids, max_targets):
        results = await super().execute(target_ids, max_targets)
        pending = []
        if self._pending_queue is not None:
            while not self._pending_queue.empty():
                target_id, allow_retest = self._pending_queue.get_nowait()
                pending.append({'targetId': target_id, 'allowRetest': allow_retest})
                self._pending_queue.task_done()
        state = {
            'status': 'pending_credentials' if pending else 'complete',
            'pending': pending,
            'credentials': [{**self.key_pool.metadata_for_slot(slot), **self.key_pool.check_admission(slot)}
                            for slot in self._lane_slots.values()],
            'inFlightCancelled': False,
            'quotaHealth': {str(slot + 1): health for slot, health in self._quota_health.items()},
        }
        path = self.config.state_root / 'credential-admission-status.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(state, ensure_ascii=False))
        temporary.chmod(0o600)
        temporary.replace(path)
        return results

    async def _run_one(self, lane, target_id, profile, run_id):
        slot = self._lane_slots[lane.index]
        if slot in self._busy_slots:
            raise RuntimeError('An evaluation lane already owns this credential slot')
        self._busy_slots.add(slot)
        try:
            # Never mutate shared settings: simultaneous lanes own independent routes.
            settings = self.key_pool.settings_for_slot(self.settings, slot)
            child = frozen.SandboxEvaluationController(self.config, self.field, self.state, settings, allow_done_rerun=self.allow_done_rerun)
            child._profile_selections = self._profile_selections.copy()
            child._target_metadata = self._target_metadata.copy()
            result = await child._run_one(lane, target_id, profile, run_id)
            result['modelCredentialSlot'] = self.key_pool.metadata_for_slot(slot)
            result['credentialAdmissionAfterRun'] = self.key_pool.finish(slot, run_id, result)
            if result.get('artifactDir'):
                path = Path(result['artifactDir']) / 'result.json'
                existing = json.loads(path.read_text())
                temporary = path.with_suffix('.key-slot.tmp')
                temporary.write_text(json.dumps({**existing, 'modelCredentialSlot': result['modelCredentialSlot'], 'credentialAdmissionAfterRun': result['credentialAdmissionAfterRun']}, ensure_ascii=False))
                temporary.replace(path)
            self._cleanup_diagnostics.update(child._cleanup_diagnostics)
            await self._refresh_quota(slot)
            return result
        finally:
            self._busy_slots.remove(slot)


async def main(args):
    frozen.base.validate_execute_args(args)
    config = frozen.base.ControllerConfig.load(args.config)
    settings = json.loads(args.sandbox_config.read_text())
    state = frozen.base.StateStore(config.state_root)
    controller = SixKeyEvaluationController(config, frozen.base.FieldClient(frozen.base.JsonHttpClient(config.field_base, config.request_timeout_seconds)), state, settings, allow_done_rerun=args.allow_done_rerun)
    if args.list_running:
        state.load()
        print(json.dumps({'running': state.running_records()}))
        return 0
    if not args.execute:
        await controller.preflight(probe_profiles=False)
        print(json.dumps({'mode': 'dry-run', 'keySlots': controller.key_pool.metadata(), 'plan': await controller.plan(set(args.target_id))}))
        return 0
    # Prevent accidentally sharing this six-key assignment across parallel batches.
    import fcntl
    with Path(settings['sixKeyPool']['exclusiveLock']).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with state.exclusive_process_lock():
            results = await controller.execute(set(args.target_id), args.max_targets)
    print(json.dumps({'mode': settings['mode'], 'results': results}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    parser = frozen.base.build_parser()
    parser.add_argument('--sandbox-config', type=Path, required=True)
    try:
        raise SystemExit(asyncio.run(main(parser.parse_args())))
    except (ValueError, RuntimeError, OSError, KeyError) as error:
        # Do not expose exception values from credential-bearing configuration.
        print('six-key controller configuration/execution error: ' + type(error).__name__, file=sys.stderr)
        raise SystemExit(2)
