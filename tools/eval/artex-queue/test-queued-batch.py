"""Linux synthetic process/lock tests. No Docker, provider or challenge calls."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

SOURCE = Path(__file__).with_name('run-queued-batch.py').read_text()
TARGETS = [f'synthetic-input-{index:02}' for index in range(20)]
IMAGE = 'sha256:' + '1' * 64
MODES = ['progressive', 'cairn', 'hypothesis']


def write(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def wait_for(predicate, process=None):
    deadline = time.monotonic() + 10
    while not predicate():
        if process is not None and process.poll() is not None:
            raise AssertionError('Synthetic process exited before the expected barrier')
        assert time.monotonic() < deadline, 'Synthetic barrier timeout'
        time.sleep(0.02)


class QueueTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='artex-queue-test-')
        self.base = Path(self.temporary.name)
        self.root = self.base / 'batch'
        self.upstream = self.base / 'upstream'
        self.root.mkdir()
        self.upstream.mkdir()
        self.children = []
        self.pool = self.base / 'pool.lock'
        self.pool.touch()
        (self.upstream / 'launch.lock').touch()
        (self.root / 'artex').mkdir()
        (self.root / 'candidate/tools/eval').mkdir(parents=True)
        write(self.root / 'work-status.json', {'status': 'prepared', 'started': False})
        write(self.root / 'targets.json', TARGETS)
        write(self.upstream / 'targets.json', TARGETS)
        config = {'maxTurns': 220, 'wallTimeoutSeconds': 3000, 'executionCapacity': 2,
                  'controllerConcurrency': 5, 'lanes': [[1], [2], [3], [4], [5]],
                  'executionMode': 'PLAN_MULTI', 'memoryReferenceEnabled': False,
                  'release': str(self.root / 'candidate')}
        sandbox = {'mode': 'artex', 'image': IMAGE, 'model': {'model': 'MiniMax-M3'},
                   'sixKeyPool': {'laneSlots': [0, 1, 2, 4, 5], 'exclusiveLock': str(self.pool)},
                   'scopes': {target: {} for target in TARGETS}}
        write(self.root / 'artex/config.json', config)
        write(self.root / 'artex/sandbox.json', sandbox)
        for mode in MODES:
            (self.upstream / mode).mkdir()
        write(self.upstream / 'hypothesis/sandbox.json', sandbox)
        protected = self.root / 'candidate/protected.txt'
        protected.write_text('frozen synthetic code')
        write(self.root / 'frozen.json', {'image': IMAGE, 'upstream': str(self.upstream),
              'upstreamFiles': {}, 'files': {str(protected): hashlib.sha256(protected.read_bytes()).hexdigest()}})
        adapted = SOURCE.replace("ROOT = Path('/home/shared/eval-runner/artex-minimax20-20261023')", f'ROOT = Path({str(self.root)!r})')
        adapted = adapted.replace("UPSTREAM = Path('/home/shared/eval-runner/plan-final-round-minimax20-20261023')", f'UPSTREAM = Path({str(self.upstream)!r})')
        adapted = adapted.replace("PYTHON = '/opt/secheur-agent-python/bin/python'", f'PYTHON = {sys.executable!r}')
        adapted = adapted.replace('POLL_SECONDS = 30', 'POLL_SECONDS = 0.02')
        (self.root / 'run-queued-batch.py').write_text(adapted)
        bin_dir = self.base / 'bin'
        bin_dir.mkdir()
        docker = bin_dir / 'docker'
        docker.write_text('#!' + sys.executable + '\nimport sys\nprint(sys.argv[3])\n')
        docker.chmod(0o755)
        self.env = {**os.environ, 'PATH': str(bin_dir) + ':' + os.environ['PATH']}
        (self.root / 'candidate/tools/eval/six_key_eval_controller.py').write_text('''import argparse,fcntl,json,pathlib
p=argparse.ArgumentParser();p.add_argument('--config');p.add_argument('--sandbox-config');p.add_argument('--allow-done-rerun',action='store_true');p.add_argument('--max-targets');p.add_argument('--target-id',action='append');p.add_argument('--execute',action='store_true');p.add_argument('--confirm');a=p.parse_args()
r=pathlib.Path(a.config).parent.parent;s=json.loads(pathlib.Path(a.sandbox_config).read_text())
probe=r/('execution-directory' if a.execute else 'preflight-directory');probe.mkdir(mode=0o755)
if not a.execute:
 (r/'preflight-called').touch();print(json.dumps({'plan':[{'targetId':t,'lane':i%5+1} for i,t in enumerate(a.target_id)]}));raise SystemExit(0)
with pathlib.Path(s['sixKeyPool']['exclusiveLock']).open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 (r/'controller-called').touch()
 for i,t in enumerate(a.target_id):
  d=r/'artex/artifacts'/str(i);d.mkdir(parents=True);(d/'result.json').write_text(json.dumps({'targetId':t,'terminalReason':'synthetic_complete'}))
 state=r/'artex/state';state.mkdir();(state/'credential-admission-status.json').write_text(json.dumps({'status':'complete','pending':[]}))
''')

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=5)
        self.temporary.cleanup()

    def upstream_status(self, phase, pid=None):
        write(self.upstream / 'work-status.json', {'status': phase, 'launcherPid': pid,
              'finishedModes': MODES if phase == 'complete' else []})

    def summaries(self):
        for mode in MODES:
            write(self.upstream / mode / 'summary.json', {'mode': mode, 'complete': True, 'exitCode': 0,
                  'recordCount': 20, 'credentialAdmissionStatus': 'complete', 'pendingQuestionCount': 0,
                  'results': [{'targetId': target} for target in TARGETS]})

    def upstream_process(self):
        script = self.upstream / 'run-batch.py'
        script.write_text('''import fcntl,json,os,pathlib,time
r=pathlib.Path(__file__).parent
with (r/'launch.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 (r/'work-status.json').write_text(json.dumps({'status':'running','launcherPid':os.getpid()}))
 (r/'ready').touch()
 while not (r/'release').exists(): time.sleep(0.02)
''')
        child = subprocess.Popen([sys.executable, str(script)])
        self.children.append(child)
        wait_for(lambda: (self.upstream / 'ready').exists(), child)
        return child

    def launch(self):
        child = subprocess.Popen([sys.executable, str(self.root / 'run-queued-batch.py')],
                                 env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.children.append(child)
        return child

    def completed_run(self):
        child = self.launch()
        child.communicate(timeout=10)
        return child.returncode

    def test_waits_for_all_modes_and_launcher_exit_then_runs_exactly_once(self):
        upstream = self.upstream_process()
        queue = self.launch()
        wait_for(lambda: (self.root / 'queue-started.json').exists(), queue)
        self.assertFalse((self.root / 'preflight-called').exists())
        self.assertEqual(self.completed_run(), 3)
        self.summaries()
        self.upstream_status('complete', upstream.pid)
        time.sleep(0.1)
        self.assertFalse((self.root / 'preflight-called').exists())
        (self.upstream / 'release').touch()
        upstream.wait(timeout=5)
        queue.communicate(timeout=10)
        self.assertEqual(queue.returncode, 0)
        self.assertEqual(len(list((self.root / 'artex/artifacts').glob('*/result.json'))), 20)
        self.assertEqual(json.loads((self.root / 'work-status.json').read_text())['status'], 'complete')
        self.assertEqual(self.completed_run(), 3)

    def test_failed_upstream_never_starts_successor(self):
        self.upstream_status('needs_attention')
        self.assertNotEqual(self.completed_run(), 0)
        self.assertFalse((self.root / 'preflight-called').exists())

    def test_controller_children_keep_readable_directories_without_relaxing_queue_metadata(self):
        self.upstream_status('complete')
        self.summaries()
        self.assertEqual(self.completed_run(), 0)
        for name in ['preflight-directory', 'execution-directory']:
            self.assertEqual((self.root / name).stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.root / 'queue-started.json').stat().st_mode & 0o777, 0o600)

    def test_unfinished_orphan_never_starts_successor(self):
        self.upstream_status('running', os.getpid())
        self.assertNotEqual(self.completed_run(), 0)
        self.assertFalse((self.root / 'preflight-called').exists())

    def test_incomplete_mode_summary_blocks_successor(self):
        self.upstream_status('complete')
        self.summaries()
        write(self.upstream / 'hypothesis/summary.json', {'complete': False})
        self.assertNotEqual(self.completed_run(), 0)
        self.assertFalse((self.root / 'preflight-called').exists())

    def test_unrelated_pool_owner_blocks_successor(self):
        self.upstream_status('complete')
        self.summaries()
        with self.pool.open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertNotEqual(self.completed_run(), 0)
        self.assertFalse((self.root / 'preflight-called').exists())

    def test_modified_frozen_code_blocks_before_waiting(self):
        self.upstream_status('complete')
        self.summaries()
        (self.root / 'candidate/protected.txt').write_text('changed')
        self.assertNotEqual(self.completed_run(), 0)
        self.assertFalse((self.root / 'queue-started.json').exists())
        self.assertFalse((self.root / 'preflight-called').exists())


if __name__ == '__main__':
    unittest.main()
