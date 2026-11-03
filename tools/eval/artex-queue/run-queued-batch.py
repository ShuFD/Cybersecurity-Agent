"""One-shot dependency queue; exits after one Artex batch, with no retries or monitoring."""
from collections import Counter
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path('/home/shared/eval-runner/artex-minimax20-20261023')
UPSTREAM = Path('/home/shared/eval-runner/plan-final-round-minimax20-20261023')
PYTHON = '/opt/secheur-agent-python/bin/python'
UPSTREAM_MODES = ['progressive', 'cairn', 'hypothesis']
POLL_SECONDS = 30
MAX_QUEUE_SECONDS = 24 * 60 * 60
os.umask(0o077)


def save(status, **fields):
    path = ROOT / 'work-status.json'
    previous = json.loads(path.read_text())
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps({**previous, 'status': status, 'queuePid': os.getpid(),
                                     'updatedAt': time.time(), **fields}, indent=2))
    temporary.replace(path)


def process_identity(pid, expected_script):
    if not isinstance(pid, int) or pid <= 0:
        return None
    try:
        proc = Path('/proc') / str(pid)
        fields = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
        args = (proc / 'cmdline').read_bytes().split(b'\0')
        if fields[0] == 'Z' or str(expected_script).encode() not in args:
            return None
        return {'pid': pid, 'startTicks': fields[19],
                'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    except FileNotFoundError:
        return None


def lock_available(path):
    # Probe an existing lock and release immediately. Never carry it into a child.
    with path.open('r') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        fcntl.flock(handle, fcntl.LOCK_UN)
        return True


def upstream_gate(targets, expected_identity):
    status = json.loads((UPSTREAM / 'work-status.json').read_text())
    phase = status.get('status')
    identity = process_identity(status.get('launcherPid'), UPSTREAM / 'run-batch.py')
    if expected_identity is not None and identity not in (None, expected_identity):
        raise RuntimeError('Upstream launcher identity changed')
    if phase in {'error', 'needs_attention', 'preflight_failed', 'cancelled', 'paused'}:
        raise RuntimeError('Upstream requires attention; successor will not start')
    if phase != 'complete':
        if phase not in {'prepared', 'preflight', 'running'} or identity is None:
            raise RuntimeError('Upstream is unfinished without its original active launcher')
        return False
    assert status.get('finishedModes') == UPSTREAM_MODES, 'Upstream completion metadata incomplete'
    for mode in UPSTREAM_MODES:
        summary = json.loads((UPSTREAM / mode / 'summary.json').read_text())
        ids = [row.get('targetId') for row in summary.get('results', [])]
        assert summary.get('complete') is True and summary.get('exitCode') == 0
        assert summary.get('recordCount') == 20 and len(ids) == len(set(ids)) == 20
        assert set(ids) == set(targets), 'Upstream result coverage mismatch'
        assert summary.get('credentialAdmissionStatus') == 'complete'
        assert summary.get('pendingQuestionCount') == 0
    return identity is None and lock_available(UPSTREAM / 'launch.lock')


def verify():
    frozen = json.loads((ROOT / 'frozen.json').read_text())
    assert frozen['upstream'] == str(UPSTREAM)
    for name, expected in {**frozen['files'], **frozen['upstreamFiles']}.items():
        assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == expected, 'Frozen input changed'
    assert subprocess.check_output(['docker', 'image', 'inspect', frozen['image'], '--format', '{{.Id}}'], text=True).strip() == frozen['image']
    targets = json.loads((ROOT / 'targets.json').read_text())
    config = json.loads((ROOT / 'artex/config.json').read_text())
    sandbox = json.loads((ROOT / 'artex/sandbox.json').read_text())
    template = json.loads((UPSTREAM / 'hypothesis/sandbox.json').read_text())
    assert len(targets) == len(set(targets)) == 20
    assert targets == json.loads((UPSTREAM / 'targets.json').read_text())
    assert (config['maxTurns'], config['wallTimeoutSeconds'], config['executionCapacity'], config['controllerConcurrency']) == (220, 3000, 2, 5)
    assert config['lanes'] == [[1], [2], [3], [4], [5]] and config['executionMode'] == 'PLAN_MULTI'
    assert config['release'] == str(ROOT / 'candidate') and config['memoryReferenceEnabled'] is False
    assert sandbox['mode'] == 'artex' and sandbox['image'] == frozen['image']
    assert sandbox['model']['model'] == 'MiniMax-M3' and sandbox['model'] == template['model']
    assert sandbox['scopes'] == template['scopes'] and set(sandbox['scopes']) == set(targets)
    assert sandbox['sixKeyPool']['laneSlots'] == [0, 1, 2, 4, 5]
    assert sandbox['sixKeyPool']['exclusiveLock'] == template['sixKeyPool']['exclusiveLock']
    return targets


def command(targets):
    args = [PYTHON, str(ROOT / 'candidate/tools/eval/six_key_eval_controller.py'),
            '--config', str(ROOT / 'artex/config.json'), '--sandbox-config', str(ROOT / 'artex/sandbox.json'),
            '--allow-done-rerun', '--max-targets', '20']
    for target in targets:
        args.extend(['--target-id', target])
    return args


def execute(targets, env):
    directory = ROOT / 'artex'
    assert not (directory / 'started.json').exists()
    assert not list((directory / 'artifacts').glob('*/result.json'))
    with (directory / 'controller.log').open('x') as log:
        child = subprocess.Popen(command(targets) + ['--execute', '--confirm', 'RUN_3_LANE_EVAL'],
                                 cwd=ROOT / 'candidate/tools/eval', env=env, stdout=log, stderr=subprocess.STDOUT,
                                 umask=0o022)
        (directory / 'started.json').write_text(json.dumps({'controllerPid': child.pid, 'at': time.time()}))
        save('running', started=True, activeMode='artex', controllerPid=child.pid)
        code = child.wait()
    records = []
    for path in (directory / 'artifacts').glob('*/result.json'):
        row = json.loads(path.read_text())
        records.append({key: row.get(key) for key in ['targetId', 'terminalReason', 'verificationState',
                        'durationSeconds', 'errorCode', 'sessionCleanupStatus', 'evaluationValidity']})
    admission_path = directory / 'state/credential-admission-status.json'
    admission = json.loads(admission_path.read_text()) if admission_path.exists() else {}
    ids = [row['targetId'] for row in records]
    complete = (code == 0 and len(ids) == len(set(ids)) == 20 and set(ids) == set(targets)
                and admission.get('status') == 'complete' and admission.get('pending') == [])
    summary = {'mode': 'artex', 'exitCode': code, 'complete': complete, 'recordCount': len(records),
               'credentialAdmissionStatus': admission.get('status', 'missing'),
               'pendingQuestionCount': len(admission.get('pending', [])),
               'success': sum(row['terminalReason'] == 'verified_true' for row in records),
               'terminalReasons': dict(Counter(str(row['terminalReason']) for row in records)), 'results': records}
    (directory / 'summary.json').write_text(json.dumps(summary, indent=2))
    (ROOT / 'summary.json').write_text(json.dumps([summary], indent=2))
    save('complete' if complete else 'needs_attention', activeMode=None, controllerPid=None,
         finishedModes=['artex'] if complete else [], results=[summary], automaticReruns=False)
    return 0 if complete else 2


def run_locked():
    if (ROOT / 'queue-started.json').exists():
        print(json.dumps({'status': 'duplicate_refused'}))
        return 3
    try:
        targets = verify()
        status = json.loads((UPSTREAM / 'work-status.json').read_text())
        expected_identity = process_identity(status.get('launcherPid'), UPSTREAM / 'run-batch.py')
        with (ROOT / 'queue-started.json').open('x') as marker:
            json.dump({'queuePid': os.getpid(), 'at': time.time(), 'upstreamIdentity': expected_identity}, marker)
        save('queued', started=False, upstreamIdentity=expected_identity)
        deadline = time.monotonic() + MAX_QUEUE_SECONDS
        while not upstream_gate(targets, expected_identity):
            if time.monotonic() >= deadline:
                raise RuntimeError('Upstream wait exceeded the queue deadline')
            time.sleep(POLL_SECONDS)
        targets = verify()
        settings = json.loads((ROOT / 'artex/sandbox.json').read_text())
        if not lock_available(Path(settings['sixKeyPool']['exclusiveLock'])):
            raise RuntimeError('Another controller owns the model pool; successor will not overlap')
        env = {**os.environ, 'PATH': '/home/shared/eval-runner/cairn-four-fixes-20261015/bin:/opt/node-v24.14.0-linux-x64/bin:/usr/bin:/bin', 'PI_OFFLINE': '1'}
        save('preflight', started=False)
        with (ROOT / 'artex/preflight.log').open('x') as log:
            result = subprocess.run(command(targets), cwd=ROOT / 'candidate/tools/eval', env=env,
                                    stdout=log, stderr=subprocess.STDOUT, umask=0o022)
        if result.returncode:
            save('preflight_failed', started=False, exitCode=result.returncode)
            return 2
        plan = json.loads((ROOT / 'artex/preflight.log').read_text()).get('plan', [])
        ids = [row.get('targetId') for row in plan]
        assert len(ids) == len(set(ids)) == 20 and set(ids) == set(targets)
        assert {row['lane'] for row in plan} == {1, 2, 3, 4, 5}
        verify()
        assert upstream_gate(targets, expected_identity)
        with (ROOT / 'started.json').open('x') as marker:
            json.dump({'launcherPid': os.getpid(), 'at': time.time()}, marker)
        return execute(targets, env)
    except Exception as error:
        save('needs_attention', errorType=type(error).__name__, reason=str(error), automaticReruns=False)
        raise


def main():
    with (ROOT / 'launch.lock').open('a') as own_lock:
        try:
            fcntl.flock(own_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'status': 'duplicate_refused'}))
            return 3
        return run_locked()


if __name__ == '__main__':
    sys.exit(main())
